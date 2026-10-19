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
type CM = {
  cmView: {
    view: {
      state: { doc: { toString(): string; length: number } }
      dispatch(s: unknown): void
      focus(): void
    }
  }
}
const docText = () =>
  page.evaluate(() =>
    (document.querySelector('.cm-content') as unknown as CM).cmView.view.state.doc.toString()
  )
const setDoc = (t: string, anchor = 0) =>
  page.evaluate(
    ([t2, a]) => {
      const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: t2 },
        selection: { anchor: a }
      })
      v.focus()
    },
    [t, anchor] as const
  )
const apiGet = (path: string) =>
  page.evaluate(async (p) => {
    const cfg = await (
      window as unknown as {
        mizajAPI: { getBackendConfig(): Promise<{ baseUrl: string; token: string }> }
      }
    ).mizajAPI.getBackendConfig()
    return (await fetch(`${cfg.baseUrl}${p}`, { headers: { 'X-Mizaj-Token': cfg.token } })).json()
  }, path)

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-lry-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: { ...process.env, MIZAJ_ENGINE_MODE: 'mock', MIZAJ_USER_DATA_DIR: userData }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز')
  await text('new-project').click()
  await text('new-project-input').fill('تعلّم')
  await text('new-project-input').press('Enter')
  await expect(text('project-item')).toHaveCount(1)
  await text('new-document').first().click()
  await text('new-document-input').fill('مستند التعلّم')
  await text('new-document-input').press('Enter')
  await expect(text('doc-title')).toHaveText('مستند التعلّم')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('typing a mark offers «حفظ هذا التشكيل؟» once per word; dictionary save and repeats', async () => {
  await setDoc('جديد كتاب جديد قلم جديد', 1)
  await page.keyboard.insertText('ِ') // kasra after the jim of the first «جديد»
  const prompt = text('learn-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText('حفظ هذا التشكيل؟')
  await expect(text('learn-repeats')).toContainText('(2)')
  await text('learn-dict').click()
  await expect(prompt).toHaveCount(0)
  await expect
    .poll(async () => {
      const list = (await apiGet('/api/dictionary')) as { word_or_phrase: string }[]
      return list.map((e) => e.word_or_phrase)
    })
    .toContain('جديد')

  // the same word is never offered again in this session
  await setDoc('جديد جديد', 1)
  await page.keyboard.insertText('ُ')
  await expect(prompt).toHaveCount(0)

  // another word: apply to the repeats
  await setDoc('كتاب قلم كتاب كتاب', 1)
  await page.keyboard.insertText('ِ')
  await expect(prompt).toBeVisible()
  await expect(text('learn-repeats')).toContainText('(2)')
  await text('learn-repeats').click()
  await expect(prompt).toHaveCount(0)
  await expect.poll(docText).toBe('كِتاب قلم كِتاب كِتاب')

  // ignore closes without touching anything
  await setDoc('قلم', 1)
  await page.keyboard.insertText('َ')
  await expect(prompt).toBeVisible()
  await text('learn-ignore').click()
  await expect(prompt).toHaveCount(0)
  expect(await docText()).toBe('قَلم')
})

test('accuracy chip: count, review from the first word, F7 navigation, position and done state', async () => {
  await setDoc('كتب الولد الدرس. ذهب الرجل بعيدا. قرأ الطالب الكتاب.')
  await text('toolbar-tashkeel').click()
  await expect(text('progress-percent')).toHaveText('100%')
  await expect.poll(() => page.locator('.cm-lowconf').count()).toBeGreaterThanOrEqual(2)
  const total = await page.locator('.cm-lowconf').count()
  const chip = text('doubt-chip')
  await expect(chip).toHaveText(`الكلمات المشكوك فيها: ${total}`)

  const ar = (n: number) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d])
  await chip.click()
  await expect(text('review-bar')).toBeVisible()
  await expect(text('doubt-position')).toHaveText(`${ar(1)} / ${ar(total)}`)
  await page.keyboard.press('F7')
  await expect(text('doubt-position')).toHaveText(`${ar(2)} / ${ar(total)}`)
  await page.keyboard.press('Shift+F7')
  await expect(text('doubt-position')).toHaveText(`${ar(1)} / ${ar(total)}`)
  await text('doubt-next').click()
  await expect(text('doubt-position')).toHaveText(`${ar(2)} / ${ar(total)}`)
  await text('doubt-prev').click()
  await expect(text('doubt-position')).toHaveText(`${ar(1)} / ${ar(total)}`)

  // accepting a word decrements N
  await page.keyboard.press('Control+Enter')
  await expect(chip).toHaveText(`الكلمات المشكوك فيها: ${total - 1}`)
  for (let i = total - 1; i > 0; i--) await page.keyboard.press('Control+Enter')
  await expect(text('doubt-chip')).toHaveText('تمت المراجعة ✓')
})

test('per-project final-ya style overrides the global setting in proofreading', async () => {
  await text('open-settings').click()
  await text('settings-mode-advanced').click()
  await text('setting-ya-style').selectOption('egyptian')
  await text('settings-close').click()
  await expect(text('settings-modal')).toHaveCount(0)

  await text('project-settings').click()
  const sel = text('project-ya-style')
  await expect(sel).toHaveValue('')
  await sel.selectOption('standard')
  await expect
    .poll(async () => ((await apiGet('/api/projects')) as { ya_style: string | null }[])[0].ya_style)
    .toBe('standard')

  await setDoc('في الدعوى مدني')
  await text('toolbar-proofread').click()
  await expect(text('proofread-ya-style')).toHaveValue('standard')
  await expect(text('proofread-group-ya')).toHaveCount(0) // the global «مصري» is not used
  await text('proofread-cancel').click()

  await sel.selectOption('') // back to the global setting
  await expect
    .poll(async () => ((await apiGet('/api/projects')) as { ya_style: string | null }[])[0].ya_style)
    .toBeNull()
  await text('toolbar-proofread').click()
  await expect(text('proofread-ya-style')).toHaveValue('egyptian')
  await expect(text('proofread-group-ya')).toBeVisible()
  await text('proofread-cancel').click()
})
