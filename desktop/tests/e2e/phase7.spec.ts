import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
const require_ = createRequire(__filename)
let app: ElectronApplication
let page: Page
let userData: string
let diagPath: string

const text = (id: string) => page.getByTestId(id)
type CM = {
  cmView: {
    view: {
      state: { doc: { toString(): string; length: number } }
      dispatch(s: unknown): void
      focus(): void
    }
  }
}
const docText = () =>
  page.evaluate(() =>
    (document.querySelector('.cm-content') as unknown as CM).cmView.view.state.doc.toString()
  )
const setDoc = (t: string) =>
  page.evaluate((t2) => {
    const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: t2 },
      selection: { anchor: 0 }
    })
    v.focus()
  }, t)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e7-'))
  diagPath = join(userData, 'diag.zip')
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_DIAG_PATH: diagPath
    }
  })
  page = await app.firstWindow()
  // transitions would race instant visibility checks; motion has its own spec (motion.spec.ts)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('find & replace ignores diacritics, replace-all is one undo step', async () => {
  await setDoc('كِتَابٌ جَمِيلٌ وكتاب آخر')
  await page.keyboard.press('Control+f')
  await expect(text('find-bar')).toBeVisible()
  await text('find-input').fill('كتاب')
  await expect(text('find-count')).toHaveText('1 / 2')
  await text('find-ignore-marks').uncheck() // exact marks: only the unmarked one
  await expect(text('find-count')).toHaveText('1 / 1')
  await text('find-ignore-marks').check()
  await text('find-replace-input').fill('مقال')
  await text('find-replace-all').click()
  await expect.poll(docText).toBe('مقال جَمِيلٌ ومقال آخر')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await expect.poll(docText).toBe('كِتَابٌ جَمِيلٌ وكتاب آخر')
  await text('find-close').click()
})

test('paragraph run shows a pending preview; accept is one undo step, reject discards', async () => {
  await setDoc('ذهب الولد إلى المدرسة\nسطر ثان')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+Home')
  await text('toolbar-tashkeel-paragraph').click()
  await expect(text('pending-preview').first()).toBeVisible()
  expect(await docText()).toBe('ذهب الولد إلى المدرسة\nسطر ثان') // nothing applied yet
  await text('pending-accept').first().click()
  await expect.poll(async () => ((await docText()).match(/[ً-ْ]/g) ?? []).length).toBeGreaterThan(3)
  expect((await docText()).split('\n')[1]).toBe('سطر ثان')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await expect.poll(docText).toBe('ذهب الولد إلى المدرسة\nسطر ثان')
  // reject path
  await page.keyboard.press('Control+Home')
  await text('toolbar-tashkeel-paragraph').click()
  await expect(text('pending-bar')).toBeVisible()
  await text('pending-reject-all').click()
  await expect(text('pending-bar')).toHaveCount(0)
  expect(await docText()).toBe('ذهب الولد إلى المدرسة\nسطر ثان')
})

test('very long paragraph: banner, explicit split (one undo step), tashkeel stays fast', async () => {
  const sentence = 'هذه جملة طويلة نسبيا للاختبار. '
  const long = sentence.repeat(300)
  await setDoc(long)
  await expect(text('long-line-banner')).toBeVisible({ timeout: 5000 })
  await text('split-long-lines').click()
  await expect(text('long-line-banner')).toHaveCount(0)
  const split = await docText()
  expect(split.split('\n').length).toBeGreaterThan(20)
  expect(split.replace(/\n/g, ' ')).toBe(long.replace(/ $/, ' '))
  await text('toggle-stats').click()
  await expect(text('stat-split')).toHaveText('1')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await docText()).split('\n').length).toBe(1)
})

test('zoom shortcuts persist; high contrast applies a black/white palette', async () => {
  await page.locator('.cm-content').click()
  const size = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--editor-size').trim()
    )
  const before = await size()
  await page.keyboard.press('Control+=')
  await expect.poll(size).toBe(`${parseInt(before) + 2}px`)
  // The setting is saved asynchronously (PUT /api/settings) — wait for it to land.
  const persisted = () =>
    page.evaluate(async () => {
      const cfg = await (
        window as unknown as {
          mizajAPI: { getBackendConfig(): Promise<{ baseUrl: string; token: string }> }
        }
      ).mizajAPI.getBackendConfig()
      return (
        (await (
          await fetch(`${cfg.baseUrl}/api/settings`, { headers: { 'X-Mizaj-Token': cfg.token } })
        ).json()) as Record<string, string>
      ).editor_font_size
    })
  await expect.poll(persisted).toBe(String(parseInt(before) + 2))
  await page.keyboard.press('Control+0')
  await expect.poll(size).toBe('20px')

  await text('open-settings').click()
  await text('setting-high-contrast').selectOption('true')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('hc')))
    .toBe(true)
  const colors = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid=app-root]') as Element
      return `${getComputedStyle(el).backgroundColor}|${getComputedStyle(el).color}`
    })
  await expect.poll(colors).toBe('rgb(0, 0, 0)|rgb(255, 255, 255)')
  await text('setting-high-contrast').selectOption('false')
  await text('settings-close').click()
})

test('keyboard-only: skip links, dialog focus trap + Escape, shortcuts dialog, live region', async () => {
  await text('skip-to-editor').focus()
  expect((await text('skip-to-editor').boundingBox())?.width ?? 0).toBeGreaterThan(60) // visible when focused
  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-content')).toBeFocused()
  await page.keyboard.press('Control+/')
  await expect(text('shortcuts-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(text('shortcuts-dialog')).toHaveCount(0)
  // settings dialog traps focus: tabbing many times never leaves it
  await text('open-settings').click()
  for (let i = 0; i < 40; i++) await page.keyboard.press('Tab')
  expect(
    await page.evaluate(() => !!document.activeElement?.closest('[data-testid=settings-modal]'))
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(text('settings-modal')).toHaveCount(0)
  await expect(text('live-region')).toHaveAttribute('aria-live', 'polite')
})

test('axe-core: no serious or critical accessibility violations', async () => {
  const src = readFileSync(require_.resolve('axe-core'), 'utf8')
  await app.evaluate(
    ({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(s),
    src
  )
  const run = async () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        `axe.run(document, { rules: { 'color-contrast': { enabled: false } } }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map(n => n.html.slice(0, 120)) }))))`
      )
    )
  // CodeMirror's scroller is intentionally tabindex=-1: the contenteditable inside it is the
  // keyboard focus target (the caret scrolls it), so that one node is exempt.
  const serious = (list: { id: string; impact: string; nodes: string[] }[]) =>
    list.filter(
      (v) =>
        ['serious', 'critical'].includes(v.impact) &&
        !v.nodes.every((n) => n.includes('cm-scroller'))
    )
  const bad = serious(JSON.parse((await run()) as string))
  expect(bad, JSON.stringify(bad, null, 1)).toEqual([])
  // and with the settings dialog + right panel open
  await text('toggle-legal-panel').click()
  await text('open-settings').click()
  const bad2 = serious(JSON.parse((await run()) as string))
  expect(bad2, JSON.stringify(bad2, null, 1)).toEqual([])
  await page.keyboard.press('Escape')
  await text('right-panel-close').click()
})

test('rich paste from Word keeps paragraphs and diacritics, drops styling', async () => {
  await setDoc('')
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', 'ignored')
    dt.setData(
      'text/html',
      `<html><body><!--StartFragment--><p class=MsoNormal style="mso-x:y"><span lang=AR-SA>كَتَبَ&nbsp;الوَلَدُ</span><o:p></o:p></p><p class=MsoNormal>الفقرة&#8207; الثانية</p><!--EndFragment--></body></html>`
    )
    const el = document.querySelector('.cm-content') as HTMLElement
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    )
  })
  await expect.poll(docText).toBe('كَتَبَ الوَلَدُ\nالفقرة الثانية')
})

test('read-aloud explains when no local Arabic voice is installed', async () => {
  await text('tts-read').click()
  const toast = page.locator('[data-testid="toasts"] [data-kind="info"]').last()
  await expect(toast).toContainText('صوت عربي محلي', { timeout: 8000 })
})

test('diagnostics bundle is a local zip without document text; about dialog shows licenses', async () => {
  const secret = 'نص سري جداً من مستند المستخدم لا يجب أن يظهر في أي مكان'
  await setDoc(secret)
  await text('open-settings').click()
  rmSync(diagPath, { force: true })
  await text('diag-export').click()
  await expect.poll(() => existsSync(diagPath), { timeout: 15_000 }).toBe(true)
  const list = execFileSync('unzip', ['-Z1', diagPath], { encoding: 'utf8' })
  for (const n of ['README.txt', 'versions.json', 'health.json', 'settings.json'])
    expect(list).toContain(n)
  const all = execFileSync('sh', ['-c', `unzip -p '${diagPath}'`], {
    encoding: 'utf8',
    maxBuffer: 1 << 26
  })
  expect(all).not.toContain('نص سري')
  expect(all).toContain('"app"')
  await text('open-about').click()
  await expect(text('about-license')).toContainText('GPL-3.0-or-later')
  await expect(text('about-licenses')).toContainText('Cairo font')
  await expect(text('about-version')).toContainText('الإصدار')
})
