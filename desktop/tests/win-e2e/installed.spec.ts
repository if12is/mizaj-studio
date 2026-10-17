// Windows E2E of the INSTALLED app with the REAL engine (Task 7.7.1).
// Run by .github/workflows/windows-e2e.yml after a silent NSIS install:
//   MIZAJ_INSTALLED_EXE=<path to Mizaj Studio.exe> npx playwright test -c playwright.win.config.ts
// The test files are the same fixtures as the mock E2E (backend/tests/fixtures).
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exe = process.env.MIZAJ_INSTALLED_EXE ?? ''
const fixtures = resolve(__dirname, '../../../backend/tests/fixtures')
const MARKS = /[ً-ْ]/g

let app: ElectronApplication
let page: Page
let userData: string
let exportPath: string

const text = (id: string) => page.getByTestId(id)
const docText = () =>
  page.evaluate(() =>
    (
      document.querySelector('.cm-content') as unknown as {
        cmView: { view: { state: { doc: { toString(): string } } } }
      }
    ).cmView.view.state.doc.toString()
  )

/** Call the sidecar HTTP API from inside the renderer (it knows base URL and token-less loopback). */
async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return page.evaluate(
    async ([p, i]) => {
      const cfg = await (
        window as unknown as { mizajAPI: { getBackendConfig(): Promise<{ baseUrl: string }> } }
      ).mizajAPI.getBackendConfig()
      const init2 = i as { method?: string; body?: unknown } | undefined
      const r = await fetch(`${cfg.baseUrl}${p as string}`, {
        method: init2?.method ?? 'GET',
        headers: { 'content-type': 'application/json' },
        body: init2?.body === undefined ? undefined : JSON.stringify(init2.body)
      })
      if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}: ${await r.text()}`)
      return await r.json()
    },
    [path, init] as const
  ) as Promise<T>
}

async function dropDocx(name: string): Promise<void> {
  const path = join(fixtures, name)
  await page.evaluate((p) => {
    const f = new File([new Uint8Array([80, 75])], p.split(/[\\/]/).pop() as string)
    Object.defineProperty(f, 'path', { value: p })
    const dt = new DataTransfer()
    dt.items.add(f)
    const ev = (t: string) =>
      new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev('dragenter'))
    document.body.dispatchEvent(ev('drop'))
  }, path)
}

function docxXml(path: string): string {
  // `tar` ships with Windows 10+ (bsdtar reads zip); unzip does not.
  return execFileSync('tar', ['-xOf', path, 'word/document.xml'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26
  })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  expect(existsSync(exe), `installed exe not found: ${exe}`).toBe(true)
  userData = process.env.MIZAJ_E2E_USERDATA ?? mkdtempSync(join(tmpdir(), 'mizaj-win-e2e-'))
  exportPath = join(userData, 'exported.docx')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.MIZAJ_ENGINE_MODE // REAL engine: must never be mock here
  app = await electron.launch({
    executablePath: exe,
    env: {
      ...env,
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_SAVE_PATH: exportPath
    },
    timeout: 180_000
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  // Keep the logs for the workflow's failure annotations; the directory is in RUNNER_TEMP.
})

test.afterEach(async (_fixtures, info) => {
  if (info.status !== info.expectedStatus && page) {
    const shot = join(userData, `fail-${info.title.replace(/\W+/g, '_')}.png`)
    await page.screenshot({ path: shot }).catch(() => undefined)
    let tail = ''
    try {
      const log = readFileSync(join(userData, 'logs', 'mizaj-main.log'), 'utf8').split('\n')
      tail = log.slice(-8).join(' | ')
    } catch {
      /* no log yet */
    }
    // Annotation visible in the run summary even when the logs are not reachable.
    console.log(
      `::error title=Windows E2E: ${info.title}::${(info.error?.message ?? '').split('\n')[0]} ${tail}`
    )
  }
})

test('sidecar is ready and the engine is real, not mock', async () => {
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز', { timeout: 120_000 })
  const h = await api<{ engine_mode: string; version: string }>('/health')
  expect(h.engine_mode).toBe('real')
  console.log(`::notice title=Windows E2E::engine real, version ${h.version}`)
})

test('select the accurate engine and create a project', async () => {
  await api('/api/settings', { method: 'PUT', body: { engine_mode: 'accurate' } })
  await text('new-project').click()
  await text('new-project-input').fill('مشروع Windows')
  await text('new-project-input').press('Enter')
  await expect(text('project-item')).toHaveCount(1)
})

test('import sample_mixed.docx, diacritize (accurate), marks added, LTR spans intact', async () => {
  await dropDocx('sample_mixed.docx')
  await expect(text('drop-stats')).toBeVisible()
  await text('drop-diacritize').click()
  await expect(text('doc-title')).toHaveText('sample_mixed')
  await expect(text('progress-percent')).toHaveText('100%', { timeout: 240_000 })
  await expect.poll(async () => (await docText()).match(MARKS)?.length ?? 0).toBeGreaterThan(10)
  const t = await docText()
  expect(t).toContain('iPhone 16 Pro')
  expect(t).toContain('calculate_total(price=100)')
  expect(t).toContain('https://example.com/store')
})

test('export DOCX keeps marks and the protected text', async () => {
  rmSync(exportPath, { force: true })
  await text('export-docx').click()
  await expect.poll(() => existsSync(exportPath), { timeout: 60_000 }).toBe(true)
  const xml = docxXml(exportPath)
  expect((xml.match(MARKS) ?? []).length).toBeGreaterThan(10)
  expect(xml).toContain('iPhone 16 Pro')
})

test('spelling check reports a misspelling', async () => {
  const r = await api<{ issues: unknown[] }>('/api/spelling/check', {
    method: 'POST',
    body: { text: 'ذهبت الى المدرسه صباحا.' }
  })
  expect(r.issues.length).toBeGreaterThan(0)
})

test('tafqeet works', async () => {
  const r = await api<Record<string, unknown>>('/api/legal/tafqeet', {
    method: 'POST',
    body: { amount: 1250, currency: 'EGP' }
  })
  expect(String(r.words).replace(MARKS, '')).toContain('ألف')
})
