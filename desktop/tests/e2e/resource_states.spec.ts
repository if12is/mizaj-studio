import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resources list states with the downloader mocked (MIZAJ_E2E_FAKE_DOWNLOAD, unpackaged builds
 * only): the first attempt of every download fails, later ones succeed slowly.
 */
const desktopDir = resolve(__dirname, '../..')
let app: ElectronApplication
let page: Page
let userData: string
const t = (id: string) => page.getByTestId(id)
const item = (id: string) => page.locator(`[data-testid="resource-item"][data-id="${id}"]`)
const RID = 'ayaspell-ar'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-resstates-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_E2E_FAKE_SAFESTORAGE: '1',
      MIZAJ_E2E_FAKE_DOWNLOAD: 'fail-once,slow'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await t('tab-online').click()
  await t('switch-online-resources').check()
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('not installed: grey chip, download size, tooltip, download needs the licence tick', async () => {
  const r = item(RID)
  await expect(r.getByTestId('resource-state')).toHaveText('غير مثبّت')
  await expect(r.getByTestId('resource-chip')).toHaveAttribute('data-status', 'missing')
  await expect(r.getByTestId('resource-chip')).toHaveAttribute('title', /غير موجود على جهازك/)
  await expect(r).toContainText('حجم التنزيل')
  await expect(r.getByTestId('resource-download')).toBeDisabled()
  await expect(r.getByTestId('resource-uninstall')).toHaveCount(0)
})

test('a failed download shows a red error chip and «إعادة المحاولة»', async () => {
  const r = item(RID)
  await r.getByTestId('resource-accept').check()
  await r.getByTestId('resource-download').click()
  await expect(r.getByTestId('resource-chip')).toHaveAttribute('data-status', 'error', {
    timeout: 15_000
  })
  await expect(r.getByTestId('resource-state')).toHaveText(/^خطأ: /)
  await expect(r.getByTestId('resource-download')).toHaveText('إعادة المحاولة')
})

test('retry: progress, then installed and auto-enabled with the «تم التفعيل» toast', async () => {
  const r = item(RID)
  await r.getByTestId('resource-download').click()
  await expect(r.getByTestId('resource-chip')).toHaveAttribute('data-status', 'downloading', {
    timeout: 15_000
  })
  await expect(r.getByTestId('resource-state')).toHaveText(/^جارٍ التنزيل…/)
  await expect(r.getByTestId('resource-chip')).toHaveAttribute('data-status', 'enabled', {
    timeout: 30_000
  })
  await expect(r.getByTestId('resource-state')).toHaveText('مثبّت ومفعّل ✓')
  const toast = t('feature-toast-spellDictionary')
  await expect(toast).toContainText('تم التفعيل')
  await expect(toast).toContainText('تجده الآن في')
})

test('installed: no download button again, disk size shown, enable/disable toggles', async () => {
  const r = item(RID)
  await expect(r.getByTestId('resource-download')).toHaveCount(0)
  await expect(r.getByTestId('resource-import')).toHaveCount(0)
  await expect(r.getByTestId('resource-update')).toHaveCount(0) // same pinned hash
  await expect(r).toContainText('الحجم على القرص')
  await expect(r.getByTestId('resource-size')).not.toHaveText('غير معروف')

  await r.getByTestId('resource-disable').click()
  await expect(r.getByTestId('resource-state')).toHaveText('مثبّت — غير مفعّل')
  await expect(r.getByTestId('resource-chip')).toHaveAttribute('data-status', 'disabled')
  await expect(r.getByTestId('resource-chip')).toHaveAttribute('title', /متوقف/)
  await expect(r.getByTestId('resource-enable')).toHaveText('تفعيل')
  await expect(r.getByTestId('resource-download')).toHaveCount(0)

  await r.getByTestId('resource-enable').click()
  await expect(r.getByTestId('resource-state')).toHaveText('مثبّت ومفعّل ✓')
})

test('the backend refuses a pointless re-download with «مثبّت بالفعل»', async () => {
  const res = await page.evaluate(async (rid) => {
    const cfg = await (
      window as unknown as {
        mizajAPI: { getBackendConfig(): Promise<{ baseUrl: string; token: string }> }
      }
    ).mizajAPI.getBackendConfig()
    const r = await fetch(`${cfg.baseUrl}/api/resources/${rid}/download`, {
      method: 'POST',
      headers: { 'X-Mizaj-Token': cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept_license: true })
    })
    return { status: r.status, body: await r.json() }
  }, RID)
  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({ already_installed: true, message_ar: 'مثبّت بالفعل' })
})

test('uninstall asks for confirmation, deletes the files and frees the space', async () => {
  const r = item(RID)
  const onDisk = (): boolean => existsSync(join(userData, 'resources', RID))
  expect(onDisk()).toBe(true)
  await r.getByTestId('resource-uninstall').click()
  await expect(r.getByTestId('resource-uninstall-confirm')).toContainText('يُحرَّر')
  await r.getByTestId('resource-uninstall-no').click()
  await expect(r.getByTestId('resource-state')).toHaveText('مثبّت ومفعّل ✓') // cancelled: untouched

  await r.getByTestId('resource-uninstall').click()
  await r.getByTestId('resource-uninstall-yes').click()
  await expect(r.getByTestId('resource-state')).toHaveText('غير مثبّت')
  await expect(t('resources-message')).toContainText('تم إلغاء التثبيت وتحرير')
  await expect(r.getByTestId('resource-download')).toBeVisible() // downloadable again
  expect(onDisk()).toBe(false)
})
