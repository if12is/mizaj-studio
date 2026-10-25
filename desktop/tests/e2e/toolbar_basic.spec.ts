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
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-tb-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_E2E_TOOLBAR_BASIC: '1'
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

test('basic toolbar by default; «متقدم…» shows the rest and is remembered', async () => {
  for (const id of [
    'toolbar-tashkeel',
    'toolbar-proofread',
    'toolbar-onestep',
    'toolbar-mode',
    'toolbar-level',
    'color-toggle',
    'toggle-page-view',
    'toggle-diff',
    'export-docx',
    'toolbar-find',
    'toolbar-review',
    'toggle-spell-panel'
  ])
    await expect(t(id)).toBeVisible()
  for (const id of [
    'toggle-stats',
    'tts-read',
    'toolbar-normalize',
    'load-sample',
    'toolbar-spell'
  ])
    await expect(t(id)).toHaveCount(0)
  await t('toolbar-advanced').click()
  await expect(t('toggle-stats')).toBeVisible()
  await expect(t('load-sample')).toBeVisible()
  await page.reload()
  await expect(t('toggle-stats')).toBeVisible()
  await t('toolbar-advanced').click()
  await expect(t('toggle-stats')).toHaveCount(0)
})
