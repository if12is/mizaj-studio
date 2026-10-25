import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
let app: ElectronApplication
let page: Page
let userData: string
const t = (id: string) => page.getByTestId(id)

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-guide-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_E2E_FAKE_SAFESTORAGE: '1'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('enabling a feature: toast says where, «أرني» closes settings and spotlights it, badge until first use', async () => {
  await expect(t('toggle-gemini-panel')).toHaveCount(0)
  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await t('tab-online').click()
  await expect(t('gemini-state')).toHaveText('غير مفعّل')
  await t('gemini-enable').check()

  const toast = t('feature-toast-gemini')
  await expect(toast).toContainText('تم التفعيل')
  await expect(toast).toContainText('تجده الآن في: شريط الأدوات ← اسأل عن المستند')
  await expect(t('gemini-state')).toContainText('مفعّل')

  await t('feature-show').click()
  await expect(t('gemini-settings')).toHaveCount(0) // settings closed
  const ring = t('spotlight-ring')
  await expect(ring).toBeVisible()
  await expect(t('spotlight-tip')).toContainText('اسأل عن المستند')

  // the ring sits exactly on the toolbar button
  // measured in one frame and polled: the ring may still be moving onto the button
  await expect
    .poll(() =>
      page.evaluate(() => {
        const r = (id: string): DOMRect =>
          document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect()
        const a = r('toggle-gemini-panel')
        const b = r('spotlight-ring')
        return Math.abs(b.x - (a.x - 4)) < 3 && Math.abs(b.y - (a.y - 4)) < 3
      })
    )
    .toBe(true)

  // gone after ~3 s
  await expect(ring).toHaveCount(0, { timeout: 6000 })

  // «جديد» badge stays until the feature is used
  await expect(t('new-badge-gemini')).toHaveText('جديد')
  await t('toggle-gemini-panel').click()
  await expect(t('new-badge-gemini')).toHaveCount(0)
})

test('resources list shows a clear status for every item', async () => {
  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await t('tab-online').click()
  const states = t('resource-state')
  await expect(states.first()).toBeVisible()
  const texts = await states.allTextContents()
  expect(texts.length).toBeGreaterThan(0)
  for (const s of texts)
    expect(s.trim()).toMatch(
      /^(غير مثبّت|جارٍ التنزيل…|جارٍ التثبيت…|مثبّت ومفعّل ✓|مثبّت — غير مفعّل|خطأ: )/
    )
  await expect(t('tool-tesseract-state')).toHaveText(/غير مثبّت|مثبّت/)
})
