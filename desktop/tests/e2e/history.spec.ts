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

const text = (id: string) => page.getByTestId(id)
type CM = { cmView: { view: { state: { doc: { toString(): string } } } } }
const docText = () =>
  page.evaluate(() =>
    (document.querySelector('.cm-content') as unknown as CM).cmView.view.state.doc.toString()
  )
const entry = (label: string) =>
  text('history-entry').filter({
    has: page.getByTestId('history-entry-label').filter({ hasText: label })
  })

const TYPED = 'بسم الله الرحمن الرحيم'

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-hist-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: { ...process.env, MIZAJ_ENGINE_MODE: 'mock', MIZAJ_USER_DATA_DIR: userData }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز')
  await text('new-project').click()
  await text('new-project-input').fill('السجل')
  await text('new-project-input').press('Enter')
  await text('new-document').first().click()
  await text('new-document-input').fill('مستند السجل')
  await text('new-document-input').press('Enter')
  await expect(text('doc-title')).toHaveText('مستند السجل')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('type, tashkeel, then restore the earlier version (and undo the restore)', async () => {
  // type for real
  await page.locator('.cm-content').click()
  await page.keyboard.type(TYPED)
  expect(await docText()).toBe(TYPED)

  // full tashkeel (records «قبل التشكيل» and «تشكيل كامل»)
  await text('toolbar-tashkeel').click()
  await expect.poll(async () => (await docText()) !== TYPED, { timeout: 20_000 }).toBe(true)
  const tashkeeled = await docText()
  expect(tashkeeled).not.toBe(TYPED)

  // open the panel with the toolbar button, close it, reopen with Ctrl+Shift+H
  await text('toolbar-history').click()
  await expect(text('history-panel')).toBeVisible()
  await text('history-close').click()
  await expect(text('history-panel')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+H')
  await expect(text('history-panel')).toBeVisible()

  // the timeline shows the named events, grouped under today
  await expect(text('history-day').first()).toHaveText('اليوم')
  await expect(entry('تشكيل كامل')).toHaveCount(1)
  await expect(entry('قبل التشكيل')).toHaveCount(1)
  await expect(entry('قبل التشكيل')).toContainText('+')

  // preview of the pre-tashkeel version vs the current text
  await entry('قبل التشكيل').click()
  await expect(text('history-preview')).toBeVisible()
  await expect(text('history-diff').locator('[data-seg="gain"]').first()).toBeVisible()
  await expect(text('history-diff').locator('[data-seg="lose"]').first()).toBeVisible()
  expect(await docText()).toBe(tashkeeled) // previewing changes nothing

  // restore with confirmation: cancel first, then confirm
  await text('history-restore').click()
  await text('confirm-cancel').click()
  expect(await docText()).toBe(tashkeeled)
  await text('history-restore').click()
  await text('confirm-ok').click()
  await expect.poll(docText).toBe(TYPED)

  // the restore is itself a version, and so is the state it replaced
  await expect(entry('استعادة نسخة')).toHaveCount(1)
  await expect(text('history-identical')).toBeVisible()

  // undo the restore by restoring the «تشكيل كامل» version
  await entry('تشكيل كامل').click()
  await text('history-restore').click()
  await text('confirm-ok').click()
  await expect.poll(docText).toBe(tashkeeled)
  await expect(entry('استعادة نسخة')).toHaveCount(2)
})

test('save a named checkpoint and see it in the timeline', async () => {
  await text('history-checkpoint-name').fill('مسودة مهمة')
  await text('history-checkpoint-save').click()
  // the text equals the newest version, so that entry is promoted to a named checkpoint
  await expect(text('history-entry').filter({ hasText: '«مسودة مهمة»' })).toHaveAttribute(
    'data-kind',
    'checkpoint'
  )
  await expect(text('history-checkpoint-name')).toHaveValue('')
  // Esc closes the panel
  await text('history-panel').press('Escape')
  await expect(text('history-panel')).toHaveCount(0)
})
