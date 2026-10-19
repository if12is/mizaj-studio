import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * WCAG AA text contrast (axe `color-contrast`, 4.5:1 / 3:1 for large text) on the main screens in
 * dark mode (the default theme). Fails with the exact nodes so a weak token can be fixed.
 */
const require_ = createRequire(__filename)
const desktopDir = resolve(__dirname, '../..')
let app: ElectronApplication
let page: Page
let userData: string
const t = (id: string) => page.getByTestId(id)

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-contrast-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
  await app.evaluate(
    ({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(s),
    readFileSync(require_.resolve('axe-core'), 'utf8')
  )
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

interface Hit {
  target: string
  summary: string
}
async function contrast(scope?: string): Promise<Hit[]> {
  const json = (await app.evaluate(
    ({ BrowserWindow }, sel) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        `axe.run(${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'document'}, { runOnly: ['color-contrast'] }).then(r => JSON.stringify(r.violations.flatMap(v => v.nodes.map(n => ({ target: String(n.target), summary: (n.any[0] && n.any[0].message) || '' })))))`
      ),
    scope ?? null
  )) as string
  return JSON.parse(json) as Hit[]
}
const expectClean = async (name: string, scope?: string) => {
  const bad = await contrast(scope)
  expect(bad, `${name}: low-contrast text\n${JSON.stringify(bad, null, 1)}`).toEqual([])
}

test('dark mode: text contrast meets WCAG AA on the main screens', async () => {
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)

  // start screen (no document open)
  await expect(t('start-screen')).toBeVisible()
  await expectClean('start screen')

  // a project and a document with a few features open
  await t('new-project').click()
  await t('new-project-input').fill('مشروع')
  await page.keyboard.press('Enter')
  await t('new-document').first().click()
  await t('new-document-input').fill('مستند')
  await page.keyboard.press('Enter')
  await expect(t('doc-title')).toHaveText('مستند')
  await page.locator('.cm-content').click({ position: { x: 4, y: 4 } })
  await page.keyboard.type('بسم الله الرحمن الرحيم ذهب الولد إلى المدرسة')
  await expect(t('start-screen')).toHaveCount(0)
  await page.waitForTimeout(400)
  await expectClean('editor + sidebar + toolbar')

  for (const panel of ['toggle-legal-panel', 'toggle-spell-panel', 'toggle-quality-panel']) {
    await t(panel).click()
    await page.waitForTimeout(300)
    await expectClean(`panel ${panel}`)
    await t(panel).click()
  }

  await t('toolbar-history').click()
  await page.waitForTimeout(400)
  await expectClean('history panel')
  await t('toolbar-history').click()

  await page.keyboard.press('Control+k')
  await t('palette-input').fill('ت')
  await expect(t('palette')).toBeVisible()
  await page.waitForTimeout(300)
  await expectClean('command palette')
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+Shift+f')
  await t('search-input').fill('المدرسة')
  await expect(t('search-result')).toHaveCount(1)
  await expectClean('search panel')
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+/')
  await expectClean('shortcuts')
  await page.keyboard.press('Escape')

  await t('file-menu').click()
  await expectClean('file menu')
  await page.keyboard.press('Escape')

  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await page.waitForTimeout(300)
  await expectClean('settings (general)')
  for (const tab of ['tab-online', 'tab-packs', 'tab-backup']) {
    const b = t(tab)
    if (await b.count()) {
      await b.click()
      await page.waitForTimeout(250)
      await expectClean(`settings ${tab}`)
    }
  }
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+p')
  await expect(t('print-preview')).toBeVisible()
  await expect(page.locator('.print-sheet').first()).toBeVisible({ timeout: 30_000 })
  await expectClean('print preview', '[data-testid="print-preview"]')
  await page.keyboard.press('Escape')
})
