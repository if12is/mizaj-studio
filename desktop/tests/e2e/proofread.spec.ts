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
const MARKS = /[ً-ْ]/g
let app: ElectronApplication
let page: Page
let userData: string

const text = (id: string) => page.getByTestId(id)
type CM = {
  cmView: {
    view: { state: { doc: { toString(): string; length: number } }; dispatch(s: unknown): void }
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
  }, t)
async function setSetting(testid: string, value: string): Promise<void> {
  await text('open-settings').click()
  await text('settings-mode-advanced').click()
  await text(testid).selectOption(value)
  await text('settings-close').click()
  await expect(text('settings-modal')).toHaveCount(0)
}

const tashkeelDone = () =>
  expect.poll(async () => /[ً-ْ]/.test(await docText()), { timeout: 20_000 }).toBe(true)

const SRC = 'محكمة ابو حمص ، فى ان المدعي اقام الدعوى .'

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-pr-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: { ...process.env, MIZAJ_ENGINE_MODE: 'mock', MIZAJ_USER_DATA_DIR: userData }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز')
  await text('new-project').click()
  await text('new-project-input').fill('تدقيق')
  await text('new-project-input').press('Enter')
  await text('new-document').first().click()
  await text('new-document-input').fill('مستند التدقيق')
  await text('new-document-input').press('Enter')
  await expect(text('doc-title')).toHaveText('مستند التدقيق')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('toolbar workflow: grouped review, opaque panel, accept per group, then tashkeel', async () => {
  await setDoc(SRC)
  await text('toolbar-proofread').click()
  const dlg = text('proofread-dialog')
  await expect(dlg).toBeVisible()
  // fully opaque popup: solid background colour, full element opacity
  const bg = await dlg.evaluate((e) => {
    const s = getComputedStyle(e)
    return { bg: s.backgroundColor, op: s.opacity }
  })
  expect(bg.op).toBe('1')
  expect(bg.bg).toMatch(/^rgb\(/)
  // groups in the owner's order
  await expect(text('proofread-group-hamza')).toContainText('همزات')
  await expect(text('proofread-group-punctuation')).toContainText('ترقيم')
  await expect(text('proofread-group-ya')).toContainText('الياء') // فى -> في (style setting)
  // nothing changes until accepted
  expect(await docText()).toBe(SRC)
  await text('proofread-accept-all-hamza').click()
  await text('proofread-accept-all-punctuation').click()
  await text('proofread-apply-run').click()
  await expect(dlg).toHaveCount(0)
  await tashkeelDone()
  const out = (await docText()).replace(MARKS, '')
  expect(out).toContain('أبو حمص،')
  expect(out).toContain('أن')
  expect(out).toContain('أقام')
  expect(out.trim().endsWith('الدعوى.')).toBe(true)
})

test('rejected items stay exactly as typed; skip runs tashkeel without applying', async () => {
  await setDoc(SRC)
  await text('toolbar-proofread').click()
  await text('proofread-accept-all-punctuation').click()
  await text('proofread-reject-all-hamza').click()
  await text('proofread-apply-run').click()
  await tashkeelDone()
  const out = (await docText()).replace(MARKS, '')
  expect(out).toContain('ابو حمص،') // hamza rejected, comma accepted
  await setDoc(SRC)
  await text('toolbar-proofread').click()
  await text('proofread-skip-run').click()
  await tashkeelDone()
  expect((await docText()).replace(MARKS, '')).toBe(SRC)
})

test('cancel leaves the text alone and does not start a run', async () => {
  await setDoc(SRC)
  await text('toolbar-proofread').click()
  await text('proofread-cancel').click()
  await expect(text('proofread-dialog')).toHaveCount(0)
  expect(await docText()).toBe(SRC)
})

test('setting «اسأل»: the normal tashkeel button asks first', async () => {
  await setDoc(SRC)
  await text('toolbar-tashkeel').click()
  await expect(text('proofread-dialog')).toBeVisible()
  await text('proofread-cancel').click()
  expect(await docText()).toBe(SRC)
})

test('setting «تلقائي للترقيم فقط»: punctuation applied silently, base letters untouched', async () => {
  await setSetting('setting-proofread-before', 'auto_punct')
  await setDoc(SRC)
  await text('toolbar-tashkeel').click()
  await expect(text('proofread-dialog')).toHaveCount(0)
  await tashkeelDone()
  const out = (await docText()).replace(MARKS, '')
  expect(out).toContain('ابو حمص،')
  expect(out).toContain('فى ان')
  expect(out.trim().endsWith('الدعوى.')).toBe(true)
})

test('setting «إيقاف»: tashkeel runs straight away', async () => {
  await setSetting('setting-proofread-before', 'off')
  await setDoc(SRC)
  await text('toolbar-tashkeel').click()
  await expect(text('proofread-dialog')).toHaveCount(0)
  await tashkeelDone()
  expect((await docText()).replace(MARKS, '')).toBe(SRC)
})

test('final-ya style setting changes the proposals', async () => {
  await setSetting('setting-ya-style', 'egyptian')
  await setDoc('في الدعوى مدني')
  await text('toolbar-proofread').click()
  await expect(text('proofread-group-ya')).toBeVisible()
  await text('proofread-ya-style').selectOption('standard')
  await expect(text('proofread-group-ya')).toHaveCount(0)
  await text('proofread-cancel').click()
  await setSetting('setting-ya-style', 'standard')
})
