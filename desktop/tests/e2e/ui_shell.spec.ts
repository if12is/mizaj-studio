import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
const phase = process.env.SHOT_PHASE ?? 'after'
const shotDir = join(desktopDir, 'test-results', 'ui-shell')
let app: ElectronApplication
let page: Page
let userData: string
const t = (id: string): ReturnType<Page['getByTestId']> => page.getByTestId(id)
const shot = (name: string): Promise<Buffer> =>
  page.screenshot({ path: join(shotDir, `${phase}-${name}.png`) })

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  mkdirSync(shotDir, { recursive: true })
  userData = mkdtempSync(join(tmpdir(), 'mizaj-shell-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: { ...process.env, MIZAJ_ENGINE_MODE: 'mock', MIZAJ_USER_DATA_DIR: userData }
  })
  page = await app.firstWindow()
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('shell screenshots', async () => {
  await shot('01-shell')
  await t('file-menu').click()
  await expect(t('file-menu-list')).toBeVisible()
  await shot('02-file-menu-open')
  await page.keyboard.press('Escape')
  await t('toggle-spell-panel').click()
  await expect(t('right-panel')).toBeVisible()
  await shot('03-panel-open')
  await page.keyboard.press('Escape')
  if (phase === 'after') await expect(t('right-panel')).toHaveCount(0)
  else await t('right-panel-close').click()
  await t('open-settings').click()
  await expect(t('settings-modal')).toBeVisible()
  await shot('04-settings-default')
  if (phase === 'after') {
    await t('settings-mode-advanced').click()
    await shot('05-settings-advanced')
  }
})

test('titlebar order and toggles (after only)', async () => {
  test.skip(phase !== 'after')
  const x = async (id: string): Promise<number> => (await t(id).boundingBox())!.x
  expect(await x('win-close')).toBeLessThan(await x('win-maximize'))
  expect(await x('win-maximize')).toBeLessThan(await x('win-minimize'))
  await t('settings-close').click()
  await expect(t('settings-modal')).toHaveCount(0) // Esc is ignored while a dialog is still leaving
  await expect(t('toggle-spell-panel')).toHaveAttribute('aria-expanded', 'false')
  await t('toggle-spell-panel').click()
  await expect(t('toggle-spell-panel')).toHaveAttribute('aria-expanded', 'true')
  await expect(t('toasts')).toContainText('قائمة الأخطاء')
  await page.keyboard.press('Escape')
  await expect(t('toggle-spell-panel')).toHaveAttribute('aria-expanded', 'false')
  // an action that cannot run explains why instead of doing nothing
  await t('toolbar-spell').scrollIntoViewIfNeeded()
  await t('poetry-toggle').click({ force: true })
  await expect(t('toasts')).toContainText('افتح مستنداً أولاً')
  await t('file-menu').click()
  await t('file-export-docx').click({ force: true })
  await expect(t('toasts')).toContainText('افتح مستنداً أولاً لتصديره')
  await expect(t('file-menu-list')).toBeVisible() // stays open so the user can pick another item
  await shot('06-blocked-feedback')
  await page.keyboard.press('Escape')
  await expect(t('brand-mark').first()).toBeVisible()
})
