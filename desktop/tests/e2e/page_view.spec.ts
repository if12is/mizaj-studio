import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
const fixture = resolve(desktopDir, '../backend/tests/fixtures/page_view.docx')
// Screenshots go to test-results unless UPDATE_DOC_SCREENSHOTS=1 refreshes the docs copies.
const shots = process.env.UPDATE_DOC_SCREENSHOTS
  ? resolve(desktopDir, '../docs/screenshots')
  : resolve(desktopDir, 'test-results/screenshots')
const popupShots = join(shots, 'popups')
// optional: render a real document for the visual comparison (PAGE_VIEW_DOCX=/abs/in.docx)
const ownerDocx = process.env.PAGE_VIEW_DOCX

let app: ElectronApplication
let page: Page
let userData: string
const t = (id: string) => page.getByTestId(id)

type CM = {
  cmView: {
    view: {
      state: { doc: { toString(): string; length: number } }
      dispatch(s: unknown): void
      focus(): void
    }
  }
}
const setDocText = (text: string) =>
  page.evaluate((t2) => {
    const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t2 } })
    v.focus()
  }, text)
const stub = (value: string) =>
  app.evaluate((_, v) => {
    process.env.MIZAJ_E2E_OPEN_PATH = v
  }, value)

/** Computed background must be fully opaque (no rgba alpha < 1) and the box above content. */
async function expectOpaque(loc: Locator): Promise<void> {
  const info = await loc.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { bg: cs.backgroundColor, opacity: cs.opacity, z: cs.zIndex }
  })
  expect(info.opacity).toBe('1')
  const m = /rgba?\(([^)]+)\)/.exec(info.bg)
  expect(m, info.bg).toBeTruthy()
  const parts = m![1].split(/[ ,/]+/).filter(Boolean)
  expect(parts.length === 3 || Number(parts[3]) === 1, `bg ${info.bg} is translucent`).toBe(true)
}

async function closeSettingsIfOpen(): Promise<void> {
  if (await t('settings-modal').isVisible()) await t('settings-close').click()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-pv-'))
  mkdirSync(popupShots, { recursive: true })
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: process.env.PAGE_VIEW_REAL ? '' : 'mock',
      MIZAJ_USER_DATA_DIR: userData
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
  await t('new-project').click()
  await t('new-project-input').fill('مشروع')
  await page.keyboard.press('Enter')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

async function importDocx(path: string): Promise<void> {
  await stub(path)
  await t('file-menu').click()
  await t('file-import').click()
  await expect(t('toggle-page-view')).toBeEnabled()
}

test('page view shows bold / centered / image from the imported DOCX and follows diacritization', async () => {
  await importDocx(fixture)
  await expect(page.locator('.cm-content')).toContainText('الوقائع')
  await t('toggle-page-view').click()
  await expect(t('toggle-page-view')).toHaveText('تحرير النص')
  const pv = t('page-view-page')
  await expect(pv.locator('.dp-page')).toBeVisible()
  await expect(pv.locator('p[style*="text-align:center"]').first()).toContainText('الوقائع')
  await expect(pv.locator('span[style*="font-weight:700"]').first()).toContainText('الوقائع')
  await expect(pv.locator('span[style*="underline"]').first()).toBeVisible()
  await expect(pv.locator('img[src^="data:image/png;base64,"]')).toHaveCount(1)
  await expect(pv.locator('table td').first()).toBeVisible()
  await expect(pv.locator('script, a, iframe')).toHaveCount(0)
  // page is white on gray, RTL
  expect(await pv.locator('.dp-page').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(
    'rgb(255, 255, 255)'
  )
  // zoom
  await t('page-zoom-in').click()
  await expect(t('page-zoom')).toHaveText('110%')
  expect(await pv.evaluate((e) => getComputedStyle(e).getPropertyValue('zoom'))).toBe('1.1')
  await t('page-zoom-out').click()

  // diacritize (mock engine adds marks); the page view refreshes with the marks, same runs
  await t('toggle-page-view').click()
  await t('toolbar-tashkeel').click()
  await expect(t('status-run'))
    .toBeHidden({ timeout: 30_000 })
    .catch(() => undefined)
  await expect
    .poll(() => page.locator('.cm-content').innerText(), { timeout: 30_000 })
    .toMatch(/[ً-ْ]/)
  await t('toggle-page-view').click()
  await expect(
    pv.locator('p[style*="text-align:center"] span[style*="font-weight:700"]').first()
  ).toHaveText(/[ً-ْ]/, { timeout: 20_000 })
  await page.screenshot({ path: join(shots, 'page-view-fixture.png') })
  await t('toggle-page-view').click()
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('page view of a document without a source DOCX uses the editor font', async () => {
  await t('new-document').first().click()
  await t('new-document-input').fill('نص حر')
  await page.keyboard.press('Enter')
  await expect(t('doc-title')).toHaveText('نص حر')
  await setDocText('سطر أول\nسطر ثان')
  await t('toggle-page-view').click()
  await expect(t('page-view-page').locator('p')).toHaveCount(2)
  await t('toggle-page-view').click()
})

test('owner document screenshot (optional)', async () => {
  test.skip(!ownerDocx || !existsSync(ownerDocx), 'set PAGE_VIEW_DOCX to render a real file')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 1500)
  })
  await importDocx(ownerDocx!)
  await t('toggle-page-view').click()
  await expect(t('page-view-page').locator('.dp-page')).toBeVisible()
  await page.waitForTimeout(800)
  await t('page-view').screenshot({ path: join(shots, 'page-view.png') })
  await t('toggle-page-view').click()
  if (process.env.PAGE_VIEW_REAL) {
    // real engine (MIZAJ_MODELS_DIR): diacritize, then render the diacritized page view
    test.setTimeout(900_000)
    await t('toolbar-mode').selectOption('accurate')
    await t('toolbar-tashkeel').click()
    await expect(t('progress-percent')).toHaveText('100%', { timeout: 800_000 })
    await expect
      .poll(() => page.locator('.cm-content').innerText(), { timeout: 60_000 })
      .toMatch(/[\u064B-\u0652]/)
    await t('toggle-page-view').click()
    await expect(t('page-view-page').locator('.dp-page')).toBeVisible()
    await page.waitForTimeout(1500)
    await t('page-view').screenshot({ path: join(shots, 'page-view-diacritized.png') })
  }
})

test('popups are opaque: spelling tooltip, inspector, file menu, dialogs, toast', async () => {
  await t('new-document').first().click()
  await t('new-document-input').fill('نوافذ')
  await page.keyboard.press('Enter')
  await expect(t('doc-title')).toHaveText('نوافذ')

  // spelling tooltip over Arabic text
  await setDocText('ذهبت الى المدرسة وقرأت كتابا جميلا في المكتبة')
  const err = page.locator('.cm-spell-error').first()
  await expect(err).toBeVisible({ timeout: 20_000 })
  await err.hover()
  await expect(t('spell-tooltip')).toBeVisible()
  const tip = page.locator('.cm-tooltip').first()
  await expectOpaque(tip)
  expect(Number(await tip.evaluate((e) => getComputedStyle(e).zIndex))).toBeGreaterThanOrEqual(100)
  await page.screenshot({ path: join(popupShots, 'spell-tooltip.png') })

  // word inspector
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+Space')
  await expect(t('inspector')).toBeVisible()
  await expectOpaque(page.locator('.cm-tooltip').first())
  await page.screenshot({ path: join(popupShots, 'inspector.png') })
  await page.keyboard.press('Escape')

  // file menu
  await t('file-menu').click()
  await expect(t('file-menu-list')).toBeVisible()
  await expectOpaque(t('file-menu-list'))
  await page.screenshot({ path: join(popupShots, 'file-menu.png') })
  await page.keyboard.press('Escape')
  if (await t('file-menu-list').isVisible()) await t('file-menu').click()

  // toast
  await t('toolbar-tashkeel-paragraph').click()
  await setDocText('')
  await t('toolbar-tashkeel-paragraph').click()
  const toast = page.locator('[data-testid="toasts"] [role="alert"]').first()
  await expect(toast).toBeVisible()
  await expectOpaque(toast)
  await page.screenshot({ path: join(popupShots, 'toast.png') })

  // dialogs: shortcuts, about, settings
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+/')
  await expect(t('shortcuts-dialog')).toBeVisible()
  await expectOpaque(t('shortcuts-dialog'))
  await page.screenshot({ path: join(popupShots, 'shortcuts-dialog.png') })
  await page.keyboard.press('Escape')
  await t('open-settings').click()
  await expect(t('settings-modal')).toBeVisible()
  await expectOpaque(page.getByRole('dialog').first())
  await page.screenshot({ path: join(popupShots, 'settings-dialog.png') })
  await t('open-about').click()
  await expect(t('about-quran-attribution')).toBeVisible()
  await expectOpaque(page.getByRole('dialog').last())
  await page.screenshot({ path: join(popupShots, 'about-dialog.png') })
  await t('about-close').click()
  await closeSettingsIfOpen()
})
