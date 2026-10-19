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

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-motion-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: { ...process.env, MIZAJ_ENGINE_MODE: 'mock', MIZAJ_USER_DATA_DIR: userData }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('splash is gone once the editor is ready and design tokens exist', async () => {
  await expect(t('splash')).toHaveCount(0)
  await expect(t('editor-host')).toBeVisible()
  const dur = await page.evaluate(() =>
    ['--m-dur-fast', '--m-dur-base', '--m-dur-slow'].map((k) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(k).trim()
      return Math.round(v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000) // CSS minifier may emit .12s
    })
  )
  expect(dur).toEqual([120, 200, 320])
})

test('settings modal transitions in and out, tabs cross-fade without errors', async () => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await expect(t('settings-modal')).toBeVisible()
  for (const k of ['dictionary', 'quran', 'general']) await t(`tab-${k}`).click()
  await expect(t('tab-general')).toHaveAttribute('aria-selected', 'true')
  await t('settings-close').click()
  await expect(t('settings-modal')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a tashkeel run with fade-in finishes and leaves no fade classes behind', async () => {
  await t('load-sample').click()
  await t('toolbar-tashkeel').click()
  await expect(t('progress-bar')).toHaveAttribute('data-state', 'done', { timeout: 60_000 })
  await expect(page.locator('.cm-fresh')).toHaveCount(0, { timeout: 5000 })
})

test('reduced motion removes the modal lingering (instant detach)', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await expect(t('settings-modal')).toBeVisible()
  await t('settings-close').click()
  expect(await t('settings-modal').count()).toBe(0)
})
