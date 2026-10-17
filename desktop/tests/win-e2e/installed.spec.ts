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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

let apiToken: string | undefined

/** Append a line to the notes file the workflow tails on failure (stdout may be swallowed). */
function note(msg: string): void {
  try {
    appendFileSync(join(userData, 'e2e-notes.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* userData not ready */
  }
  console.log(msg)
}

/** Call the sidecar HTTP API from Node (no CORS), with the per-launch token when there is one. */
async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const cfg = await page.evaluate(() =>
    (
      window as unknown as { mizajAPI: { getBackendConfig(): Promise<{ baseUrl: string }> } }
    ).mizajAPI.getBackendConfig()
  )
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiToken) headers['X-Mizaj-Token'] = apiToken
  const r = await fetch(`${cfg.baseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body)
  })
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`)
  return (await r.json()) as T
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
  userData = process.env.MIZAJ_E2E_USERDATA ?? mkdtempSync(join(tmpdir(), 'mizaj-win-e2e-'))
  mkdirSync(userData, { recursive: true })
  exportPath = join(userData, 'exported.docx')
  try {
    expect(existsSync(exe), `installed exe not found: ${exe}`).toBe(true)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env.MIZAJ_ENGINE_MODE // REAL engine: must never be mock here
    note(`launching ${exe}`)
    app = await electron.launch({
      executablePath: exe,
      env: {
        ...env,
        MIZAJ_USER_DATA_DIR: userData,
        MIZAJ_E2E_SAVE_PATH: exportPath,
        MIZAJ_E2E_EXPOSE_TOKEN: '1'
      },
      timeout: 180_000
    })
    const out = (d: Buffer) => appendFileSync(join(userData, 'electron-output.log'), d)
    app.process().stdout?.on('data', out)
    app.process().stderr?.on('data', out)
    page = await app.firstWindow()
    page.on('console', (m) => m.type() === 'error' && note(`renderer error: ${m.text()}`))
    page.on('pageerror', (e) => note(`renderer exception: ${e.message}`))
    // Present once the per-launch token feature lands; undefined before that.
    apiToken = await app
      .evaluate(() => process.env.MIZAJ_API_TOKEN)
      .then((t) => t || undefined)
      .catch(() => undefined)
    note(`launched; api token ${apiToken ? 'obtained' : 'not in use'}`)
  } catch (e) {
    note(`beforeAll failed: ${(e as Error).message}`)
    throw e
  }
})

test.afterAll(async () => {
  await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 30_000))]).catch(
    () => undefined
  )
  // Keep the logs for the workflow's failure annotations; the directory is in RUNNER_TEMP.
})

// Playwright requires a destructuring pattern for the fixtures argument.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    note(`FAILED "${info.title}": ${(info.error?.message ?? '').split('\n')[0]}`)
    if (page) {
      const shot = join(userData, `fail-${info.title.replace(/\W+/g, '_')}.png`)
      await page.screenshot({ path: shot }).catch(() => undefined)
    }
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
