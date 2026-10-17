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

const desktopDir = resolve(__dirname, '../..')
const fixtures = resolve(desktopDir, '../backend/tests/fixtures')
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

/** Run the real drop handler: dispatch a drop whose File has an on-disk path. */
async function dropDocx(name: string): Promise<void> {
  const path = join(fixtures, name)
  await page.evaluate((p) => {
    // webUtils.getPathForFile returns '' for synthetic files; DropOverlay then falls
    // back to file.path, which we set to the real fixture path.
    const f = new File([new Uint8Array([80, 75])], p.split('/').pop() as string)
    Object.defineProperty(f, 'path', { value: p })
    const dt = new DataTransfer()
    dt.items.add(f)
    const ev = (t: string) =>
      new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev('dragenter'))
    document.body.dispatchEvent(ev('drop'))
  }, path)
}

function sidecarPids(): number[] {
  const log = readFileSync(join(userData, 'logs', 'mizaj-main.log'), 'utf8')
  return [...log.matchAll(/sidecar started pid=(\d+)/g)].map((m) => Number(m[1]))
}

function docxXml(path: string): string {
  const head = readFileSync(path).subarray(0, 2).toString('latin1')
  expect(head).toBe('PK')
  return execFileSync('unzip', ['-p', path, 'word/document.xml'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26
  })
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-'))
  exportPath = join(userData, 'exported.docx')
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E: '1',
      MIZAJ_E2E_SAVE_PATH: exportPath
    }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test.describe.configure({ mode: 'serial' })

test('sidecar starts and the status bar says ready', async () => {
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز')
  await expect(text('statusbar')).toBeVisible()
})

test('create a project to import into', async () => {
  await text('new-project').click()
  await text('new-project-input').fill('مشروع E2E')
  await text('new-project-input').press('Enter')
  await expect(text('project-item')).toHaveCount(1)
})

for (const name of ['sample_ar.docx', 'sample_mixed.docx']) {
  test(`import ${name}, diacritize, edit a mark, export`, async () => {
    await expect(text('progress-bar')).toBeHidden() // previous run's 'done' bar has gone
    await dropDocx(name)
    await expect(text('drop-stats')).toBeVisible()
    await text('drop-diacritize').click()
    await expect(text('doc-title')).toHaveText(name.replace('.docx', ''))

    // run finishes: progress bar reaches done / 100%
    await expect(text('progress-percent')).toHaveText('100%')
    await expect.poll(async () => (await docText()).match(MARKS)?.length ?? 0).toBeGreaterThan(10)
    const t = await docText()
    if (name === 'sample_mixed.docx') {
      expect(t).toContain('iPhone 16 Pro')
      expect(t).toContain('calculate_total(price=100)')
      expect(t).toContain('https://example.com/store')
    }

    // inspector on the first Arabic word: change one letter's marks
    await page.evaluate(() => {
      const v = (
        document.querySelector('.cm-content') as unknown as {
          cmView: {
            view: {
              state: { doc: { toString(): string } }
              dispatch(s: unknown): void
              focus(): void
            }
          }
        }
      ).cmView.view
      const i = v.state.doc.toString().search(/[ء-ي]/)
      v.dispatch({ selection: { anchor: i + 1 } })
      v.focus()
    })
    const before = await docText()
    await page.keyboard.press('Control+Space')
    await expect(text('inspector')).toBeVisible()
    await text('harakat-btn').nth(2).click() // kasra on the selected (first) letter
    await expect.poll(docText).not.toBe(before)
    const after = await docText()
    expect(after.replace(MARKS, '')).toBe(before.replace(MARKS, ''))
    await page.keyboard.press('Escape')

    // export through the (stubbed) native save dialog
    rmSync(exportPath, { force: true })
    await text('export-docx').click()
    await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true)
    await expect(page.locator('[data-testid="toasts"] [data-kind="success"]').last()).toBeVisible()
    const xml = docxXml(exportPath)
    expect((xml.match(MARKS) ?? []).length).toBeGreaterThan(10)
    if (name === 'sample_mixed.docx') expect(xml).toContain('iPhone 16 Pro')
  })
}

test('settings shows the models version section', async () => {
  await text('open-settings').click()
  await expect(text('settings-modal')).toBeVisible()
  await expect(text('pack-version')).toBeVisible()
  await expect(text('pack-apply')).toBeVisible()
  await text('settings-close').click()
})

test('crash recovery: killed sidecar restarts and becomes ready again', async () => {
  const pids = sidecarPids()
  const pid = pids[pids.length - 1]
  expect(pid).toBeGreaterThan(0)
  process.kill(pid, 'SIGKILL')
  await expect(text('status-sidecar')).toContainText('إعادة تشغيل')
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز', { timeout: 60_000 })
  const now = sidecarPids()
  expect(now.length).toBe(pids.length + 1)
  expect(now[now.length - 1]).not.toBe(pid)
  // the UI talks to the new sidecar (new port)
  await text('document-item').first().click()
  await expect(text('doc-title')).not.toHaveText('لم يتم اختيار مستند')
})
