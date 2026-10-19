import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Natural Arabic read-aloud (Piper). The real piper is replaced by tests/fixtures/fake_piper.py
 * through the unpackaged-only hook MIZAJ_E2E_FAKE_PIPER; it logs argv + stdin and returns a tiny WAV.
 */
const desktopDir = resolve(__dirname, '../..')
let app: ElectronApplication
let page: Page
let userData: string
let logFile: string
const t = (id: string) => page.getByTestId(id)
interface CM {
  cmView: { view: import('@codemirror/view').EditorView }
}
const setDoc = (text: string) =>
  page.evaluate((x) => {
    const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: x },
      selection: { anchor: 0 }
    })
  }, text)
const calls = (): { argv: string[]; stdin: string }[] =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l.replace(/'/g, '"').replace(/\\x/g, '\\u00')))
    : []

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-piper-'))
  logFile = join(userData, 'fake-piper.log')
  const fake = resolve(desktopDir, 'tests/fixtures/fake_piper.py')
  chmodSync(fake, 0o755)
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_E2E_FAKE_SAFESTORAGE: '1',
      MIZAJ_E2E_FAKE_PIPER: fake,
      FAKE_PIPER_LOG: logFile,
      FAKE_PIPER_FAIL_ON: 'ZZZ'
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

test.describe.configure({ mode: 'serial' })

test('choose «Piper — كريم (طبيعي)», read: text goes via stdin (diacritized), controls work', async () => {
  await t('open-settings').click()
  await expect(t('sec-tts')).toBeVisible()
  await expect(t('setting-tts-diacritized')).toBeChecked() // on by default
  await t('setting-tts-engine').selectOption('piper')
  await expect.poll(() => t('setting-tts-engine').inputValue()).toBe('piper')
  await page.keyboard.press('Escape')

  await setDoc('ذهب الولد إلى المدرسة. رجع الولد إلى البيت. نام الولد باكرا.')
  await t('tts-read').click()
  await expect(t('tts-pause')).toBeVisible()
  await expect(t('tts-read')).toContainText('إيقاف القراءة')
  await expect.poll(() => calls().length).toBeGreaterThanOrEqual(1)

  // the sentence being read is highlighted in the editor
  await expect(page.locator('.cm-reading')).toHaveCount(1)

  await t('tts-pause').click()
  await expect(t('tts-pause')).toContainText('متابعة القراءة')
  await t('tts-pause').click()
  await expect(t('tts-pause')).toContainText('إيقاف مؤقت')

  await t('tts-read').click() // stop
  await expect(t('tts-pause')).toHaveCount(0)
  await expect(t('tts-read')).toContainText('قراءة بصوت عالٍ')
  await expect(page.locator('.cm-reading')).toHaveCount(0)

  const c = calls()
  for (const x of c) {
    expect(x.argv.join(' ')).not.toContain('الولد') // never in argv
    expect(x.argv).toContain('--length_scale')
    expect(x.argv).toContain('--output_file')
    expect(x.stdin).toMatch(/[ً-ْ]/) // the diacritized text was fed
  }
  // private temp files are gone
  const tmp = join(userData, 'tts-tmp')
  if (existsSync(tmp)) expect(readdirSync(tmp)).toEqual([])
})

test('reads to the end on its own and the button returns to idle', async () => {
  await setDoc('جملة واحدة قصيرة.')
  await t('tts-read').click()
  await expect(t('tts-pause')).toBeVisible()
  await expect(t('tts-pause')).toHaveCount(0, { timeout: 20_000 })
  await expect(t('tts-read')).toContainText('قراءة بصوت عالٍ')
})

test('a failing Piper falls back to the system voice with an Arabic notice', async () => {
  await setDoc('ZZZ.')
  await t('tts-read').click()
  const toast = page.locator('[data-testid="toasts"] [data-kind="info"]').filter({
    hasText: 'فشل توليد الصوت بمحرك Piper'
  })
  await expect(toast.first()).toContainText('بصوت النظام')
  await expect(t('tts-read')).toContainText('قراءة بصوت عالٍ')
})

test('resources list shows Piper engine and voice as not installed, with the licence notice', async () => {
  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await t('tab-online').click()
  const voice = page.locator(
    '[data-testid="resource-item"][data-id="piper-voice-ar-jo-kareem-medium"]'
  )
  await expect(voice.getByTestId('resource-state')).toHaveText('غير مثبّت')
  await expect(voice.getByTestId('resource-notice')).toContainText(
    'ترخيص بيانات تدريب هذا الصوت غير محدد من مصدره؛ يُنزَّل للاستخدام الشخصي على جهازك فقط'
  )
  await expect(voice.getByTestId('resource-download')).toBeDisabled() // needs the licence checkbox
  await voice.getByTestId('resource-accept').check()
  const engine = page.locator('[data-testid="resource-item"][data-id="piper-engine-win"]')
  await expect(engine.getByTestId('resource-state')).toHaveText('غير مثبّت')
})
