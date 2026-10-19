import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Word add-in. Real Word cannot run here: Office.js and the Word document are replaced by a fake
 * (word-addin/test/fakeOffice.cjs) injected into the add-in pages BEFORE their scripts run. Everything
 * else is real: the Electron main process serving https://localhost with the generated
 * self-signed certificate, the pairing / Origin checks, the Python engine in mock mode, the built
 * task pane and commands pages. reg.exe / certutil.exe are an in-memory fake (MIZAJ_E2E_WORDADDIN_MOCK,
 * honoured only by an unpackaged build).
 */
const desktopDir = resolve(__dirname, '../..')
const FAKE = join(desktopDir, 'word-addin/test/fakeOffice.cjs')
let app: ElectronApplication
let page: Page
let userData: string
let port: number

const t = (id: string) => page.getByTestId(id)

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => ok(p))
    })
  })
}

async function openTab(): Promise<void> {
  if (!(await t('settings-modal').isVisible())) await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await t('tab-wordaddin').click()
  await expect(t('wordaddin-settings')).toBeVisible()
}

const SELECTION_ALL = (paras: { runs: { t: string }[] }[]) => ({
  from: { p: 0, c: 0 },
  to: { p: paras.length - 1, c: paras[paras.length - 1].runs.reduce((n, r) => n + r.t.length, 0) }
})

interface FakeSpec {
  paragraphs: {
    runs: { t: string; fmt?: Record<string, unknown> }[]
    fields?: number
    table?: number
  }[]
  selection: unknown
}

/** Opens one of the add-in pages in a second window, trusting exactly the generated certificate. */
async function openAddinPage(path: string, query: string, spec: FakeSpec): Promise<Page> {
  const certPem = readFileSync(join(userData, 'wordaddin', 'cert.pem'), 'utf8')
  const winPromise = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow, session }, pem) => {
    const ses = session.fromPartition('wordaddin-test')
    // test only: accept the one certificate the app generated (what the Windows Root store does)
    ses.setCertificateVerifyProc((req, cb) =>
      cb(req.hostname === 'localhost' && req.certificate.data.trim() === pem.trim() ? 0 : -2)
    )
    const w = new BrowserWindow({
      show: false,
      width: 420,
      height: 700,
      webPreferences: { partition: 'wordaddin-test', sandbox: true, contextIsolation: true }
    })
    void w.loadURL('about:blank')
  }, certPem)
  const p = await winPromise
  await p.addInitScript({ path: FAKE })
  await p.addInitScript((s) => {
    const f = (
      window as unknown as { __createFakeWord(s: unknown): Record<string, unknown> }
    ).__createFakeWord(s)
    Object.assign(window, { Office: f.Office, Word: f.Word, __fake: f })
  }, spec)
  const res = await p.goto(`https://localhost:${port}${path}${query}`)
  expect(res?.status()).toBe(200)
  return p
}

const pairToken = (): string => {
  const xml = readFileSync(join(userData, 'wordaddin', 'catalog', 'mizaj-word-addin.xml'), 'utf8')
  return /taskpane\.html\?k=([A-Za-z0-9_-]+)/.exec(xml)?.[1] ?? ''
}

type Fake = {
  getDoc(): { t: string; fmt: Record<string, unknown> }[][]
  stats: { writeBatches: number }
}
const doc = (p: Page) => p.evaluate(() => (window as unknown as { __fake: Fake }).__fake.getDoc())
const batches = (p: Page) =>
  p.evaluate(() => (window as unknown as { __fake: Fake }).__fake.stats.writeBatches)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-wa-'))
  port = await freePort()
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_E2E_WORDADDIN_MOCK: '1',
      MIZAJ_E2E_WORDADDIN_PORT: String(port)
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(userData, { recursive: true, force: true })
})

test('everything is off by default: no listener, no files, no certificate', async () => {
  await openTab()
  await expect(t('wa-explainer')).toContainText('https://localhost')
  await expect(t('wa-explainer')).toContainText('دون إنترنت')
  await expect(t('wa-enabled')).not.toBeChecked()
  await expect(t('wa-running')).toHaveText('متوقف')
  await expect(t('wa-installed')).toHaveText('غير مثبّتة')
  await expect(t('wa-install-btn')).toBeDisabled()
  await expect(t('wa-test-btn')).toBeDisabled()
  expect(existsSync(join(userData, 'wordaddin'))).toBe(false)
  await t('settings-mode-basic').click()
  await expect(t('tab-wordaddin')).toHaveCount(0) // Advanced only
})

test('enable, consent, install, verify, uninstall', async () => {
  await openTab()
  await t('wa-enabled').check()
  await expect(t('wa-running')).toContainText(`https://localhost:${port}`)
  await expect(t('wa-cert')).toContainText('غير موثوقة بعد')
  // installing needs the explicit consent box
  await expect(t('wa-install-btn')).toBeDisabled()
  await t('wa-consent').check()
  await t('wa-install-btn').click()
  await expect(t('wa-step-registry')).toContainText('سُجّلت الإضافة')
  await expect(t('wa-installed')).toHaveText('مثبّتة')
  await expect(t('wa-cert')).toContainText('موثوقة في ويندوز')
  const reg = await app.evaluate(
    () =>
      (globalThis as unknown as { __mizajWordAddin: { win: { registry: Map<string, string> } } })
        .__mizajWordAddin.win.registry.size
  )
  expect(reg).toBe(1)
  // the private key is stored only encrypted
  const key = readFileSync(join(userData, 'wordaddin', 'key.bin'), 'utf8')
  expect(key).not.toContain('PRIVATE KEY')
  expect(readFileSync(join(userData, 'wordaddin', 'config.json'), 'utf8')).not.toContain('PRIVATE')

  await t('wa-test-btn').click()
  await expect(t('wa-checks')).toBeVisible()
  await expect(page.locator('[data-testid^="wa-check-"][data-level="fail"]')).toHaveCount(0)
  await expect(t('wa-check-server')).toContainText('يعمل')

  // uninstall removes registration, trust and the certificate; the old pairing token dies with it
  await t('wa-uninstall-btn').click()
  await expect(t('wa-installed')).toHaveText('غير مثبّتة')
  expect(existsSync(join(userData, 'wordaddin', 'catalog'))).toBe(false)
  const left = await app.evaluate(() => {
    const w = (
      globalThis as unknown as {
        __mizajWordAddin: { win: { registry: Map<string, string>; roots: Set<string> } }
      }
    ).__mizajWordAddin.win
    return [w.registry.size, w.roots.size]
  })
  expect(left).toEqual([0, 0])
  await t('wa-install-btn').isDisabled()
})

test('declining the Windows certificate prompt is reported and nothing is registered', async () => {
  await app.evaluate(() => {
    ;(
      globalThis as unknown as { __mizajWordAddin: { win: { declineTrust: boolean } } }
    ).__mizajWordAddin.win.declineTrust = true
  })
  await openTab()
  await t('wa-consent').check()
  await t('wa-install-btn').click()
  await expect(t('wa-step-trust')).toContainText('لم تُقبل الثقة')
  await expect(t('wa-installed')).toHaveText('غير مثبّتة')
  await app.evaluate(() => {
    ;(
      globalThis as unknown as { __mizajWordAddin: { win: { declineTrust: boolean } } }
    ).__mizajWordAddin.win.declineTrust = false
  })
  await t('wa-install-btn').click() // now accepted
  await expect(t('wa-installed')).toHaveText('مثبّتة')
})

const PARAS: FakeSpec['paragraphs'] = [
  {
    runs: [
      { t: 'كتاب ', fmt: { bold: true } },
      { t: 'جميل ' },
      { t: 'جدا', fmt: { color: '#ff0000', size: 18 } }
    ]
  },
  {
    runs: [
      { t: 'قل', fmt: { italic: true } },
      { t: 'م', fmt: { bold: true } }
    ]
  },
  { runs: [{ t: 'صفحة 12' }], fields: 1 },
  { runs: [{ t: 'خلية', fmt: { italic: true } }], table: 1 }
]
const strip = (s: string) => s.replace(/[ً-ْٰ]/g, '')

test('task pane over real HTTPS: tashkeel preview, then «استبدال» keeps every formatting run', async () => {
  const tp = await openAddinPage('/taskpane.html', `?k=${pairToken()}`, {
    paragraphs: PARAS,
    selection: SELECTION_ALL(PARAS)
  })
  const q = (id: string) => tp.getByTestId(id)
  await expect(q('conn')).toHaveText('متصل بمِزَاج')
  // the pairing token was removed from the address bar
  expect(tp.url()).not.toContain('k=')
  const before = await doc(tp)

  await q('op-tashkeel').click()
  await expect(q('preview')).toBeVisible()
  await expect(q('preview').locator('ins').first()).toBeVisible()
  await expect(q('notes')).toContainText('1 فقرة تحتوي حقولاً') // the field paragraph is announced as left alone
  expect(await batches(tp)).toBe(0) // preview writes nothing
  expect(await doc(tp)).toEqual(before)

  await q('apply').click()
  await expect(q('status')).toContainText('تم الاستبدال')
  const after = await doc(tp)
  // paragraph 0: same three runs, same formats, base letters identical, marks added
  expect(after[0].map((r) => r.fmt)).toEqual(before[0].map((r) => r.fmt))
  expect(after[0].map((r) => strip(r.t))).toEqual(before[0].map((r) => r.t))
  expect(after[0].map((r) => r.t).join('')).not.toBe(before[0].map((r) => r.t).join(''))
  // paragraph 1: a word split over an italic and a bold run stays split
  expect(after[1].map((r) => r.fmt)).toEqual([{ italic: true }, { bold: true }])
  expect(after[1].map((r) => strip(r.t))).toEqual(['قل', 'م'])
  // the field paragraph is byte-for-byte untouched; the table cell is edited, its run kept
  expect(after[2]).toEqual(before[2])
  expect(after[3].map((r) => r.fmt)).toEqual([{ italic: true }])
  expect(strip(after[3][0].t)).toBe('خلية')
  // all writes were sent in ONE batch (one Ctrl+Z in Word)
  expect(await batches(tp)).toBe(1)
  await tp.close()
})

test('ribbon command (function file) processes the selection directly', async () => {
  const paras: FakeSpec['paragraphs'] = [
    {
      runs: [
        { t: 'انا ', fmt: { bold: true } },
        { t: 'كتاب', fmt: { italic: true } }
      ]
    }
  ]
  const cp = await openAddinPage('/commands.html', `?k=${pairToken()}`, {
    paragraphs: paras,
    selection: SELECTION_ALL(paras)
  })
  await cp.waitForFunction(() => {
    const o = (window as unknown as { Office?: { __actions: Record<string, unknown> } }).Office
    return !!o && typeof o.__actions.mizajAll === 'function'
  })
  await cp.evaluate(
    () =>
      new Promise<void>((done) =>
        (
          window as unknown as { Office: { __actions: Record<string, (e: unknown) => void> } }
        ).Office.__actions.mizajAll({ completed: () => done() })
      )
  )
  const after = await doc(cp)
  expect(after[0].map((r) => r.fmt)).toEqual([{ bold: true }, { italic: true }])
  expect(after[0][0].t.startsWith('أ')).toBe(true) // hamza fixed inside the bold run
  expect(strip(after[0][1].t)).toBe('كتاب')
  expect(await batches(cp)).toBe(1)
  await cp.close()
})

test('wrong pairing token: the page is refused; the right one is served', async () => {
  const ca = readFileSync(join(userData, 'wordaddin', 'cert.pem'), 'utf8')
  const get = (path: string, host = `localhost:${port}`): Promise<number> =>
    new Promise((ok) => {
      https
        .get(
          { host: '127.0.0.1', port, path, ca, servername: 'localhost', headers: { host } },
          (r) => {
            r.resume()
            ok(r.statusCode ?? 0)
          }
        )
        .on('error', () => ok(0))
    })
  expect(await get('/taskpane.html?k=wrong')).toBe(403)
  expect(await get('/taskpane.html')).toBe(403)
  expect(await get(`/taskpane.html?k=${pairToken()}`)).toBe(200)
  expect(await get(`/taskpane.html?k=${pairToken()}`, 'evil.example')).toBe(403)
})

test('app not running: the add-in says «افتح برنامج مِزَاج أولاً»', async () => {
  const tp = await openAddinPage('/taskpane.html', `?k=${pairToken()}`, {
    paragraphs: PARAS,
    selection: SELECTION_ALL(PARAS)
  })
  await expect(tp.getByTestId('conn')).toHaveText('متصل بمِزَاج')
  // the user turns the feature off (the listener stops, as if Mizaj had been closed)
  await page.evaluate(() =>
    (
      window as unknown as { mizajAPI: { wordAddin: { setEnabled(v: boolean): Promise<unknown> } } }
    ).mizajAPI.wordAddin.setEnabled(false)
  )
  await tp.getByTestId('op-tashkeel').click()
  await expect(tp.getByTestId('status')).toHaveText('افتح برنامج مِزَاج أولاً')
  await expect(tp.getByTestId('banner')).toHaveText('افتح برنامج مِزَاج أولاً')
  await expect(tp.getByTestId('conn')).toHaveText('غير متصل')
  await tp.close()
})
