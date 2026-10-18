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
    view: {
      state: {
        doc: { toString(): string; length: number }
        selection: { main: { from: number; to: number } }
        sliceDoc(a: number, b: number): string
      }
      dispatch(s: unknown): void
      focus(): void
    }
  }
}
const docText = () =>
  page.evaluate(() =>
    (document.querySelector('.cm-content') as unknown as CM).cmView.view.state.doc.toString()
  )
const selectedText = () =>
  page.evaluate(() => {
    const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
    const r = v.state.selection.main
    return v.state.sliceDoc(r.from, r.to)
  })
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
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-q-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: { ...process.env, MIZAJ_ENGINE_MODE: 'mock', MIZAJ_USER_DATA_DIR: userData }
  })
  page = await app.firstWindow()
  // transitions would race instant visibility checks; motion has its own spec (motion.spec.ts)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز')
  await text('new-project').click()
  await text('new-project-input').fill('جودة')
  await text('new-project-input').press('Enter')
  await expect(text('project-item')).toHaveCount(1) // list re-rendered: no detached click
  await text('new-document').first().click()
  await text('new-document-input').fill('مستند الجودة')
  await text('new-document-input').press('Enter')
  await expect(text('doc-title')).toHaveText('مستند الجودة')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('low-confidence words are underlined after a run; review mode navigates them with the keyboard', async () => {
  await setDoc('كتب الولد الدرس. ذهب الرجل بعيدا. قرأ الطالب الكتاب.')
  await text('toolbar-tashkeel').click()
  await expect(text('progress-percent')).toHaveText('100%')
  await expect.poll(() => page.locator('.cm-lowconf').count()).toBeGreaterThanOrEqual(2)
  const total = await page.locator('.cm-lowconf').count()

  await page.locator('.cm-content').click()
  await page.keyboard.press('F7')
  await expect(text('review-bar')).toBeVisible()
  await expect(text('review-progress')).toContainText(`0 / ${total}`)
  const first = await selectedText()
  expect(first.replace(MARKS, '').length).toBeGreaterThan(1)
  await page.keyboard.press('Control+Enter') // keep + next
  await expect(text('review-progress')).toContainText(`1 / ${total}`)
  expect(await selectedText()).not.toBe(first)
  await page.keyboard.press('Shift+F7')
  await page.keyboard.press('F7')
  await page.keyboard.press('Escape')
  await expect(text('review-bar')).toHaveCount(0)
  // reviewed words are no longer highlighted as doubtful
  await expect.poll(() => page.locator('.cm-lowconf:not(.cm-lowconf-done)').count()).toBe(total - 1)
})

test('confidence underline can be switched off in the quality settings panel', async () => {
  await text('toggle-quality-panel').click()
  await expect(text('editor-quality-settings')).toBeVisible()
  await text('setting-confidence-show').uncheck()
  await expect(text('editor-host')).toHaveClass(/conf-off/)
  await text('setting-confidence-show').check()
  await expect(text('editor-host')).not.toHaveClass(/conf-off/)
})

test('proper nouns: add from the inspector, list/delete in the manager', async () => {
  await setDoc('زار محمد غزة', 6)
  await page.keyboard.press('Control+Space')
  await expect(text('inspector')).toBeVisible()
  await text('add-proper-noun').click()
  await expect
    .poll(async () =>
      ((await apiGet('/api/names')) as { term: string }[]).some((n) => n.term === 'محمد')
    )
    .toBe(true)
  await page.keyboard.press('Escape')
  await text('names-search').fill('محمد')
  await expect(text('names-row').first()).toContainText('محمد')
  await text('names-term').fill('غزة')
  await text('names-kind').fill('مكان')
  await text('names-save').click()
  await text('names-search').fill('غزة')
  await expect(
    page.locator('[data-testid=names-row][data-builtin=false]').filter({ hasText: 'غزة' })
  ).toHaveCount(1)
  await text('names-delete').first().click()
  await expect(
    page.locator('[data-testid=names-row][data-builtin=false]').filter({ hasText: 'غزة' })
  ).toHaveCount(0)
  await text('right-panel-close').click()
})

test("i'rab tab explains honestly; Gemini stays hidden when not enabled", async () => {
  await setDoc('ذهب الولد إلى المدرسة', 6)
  await page.keyboard.press('Control+.')
  await expect(text('inspector')).toBeVisible()
  await expect(text('gemini-ask')).toHaveCount(0)
  await text('inspector-tab-irab').click()
  await expect(text('irab-panel')).toBeVisible()
  await expect(text('irab-panel')).toContainText('غير متأكد', { timeout: 10_000 })
  await page.keyboard.press('Escape')
})

test('repeated identical corrections are suggested back (explicit dictionary add)', async () => {
  await setDoc('كتاب', 2)
  const edit = async () => {
    await page.keyboard.press('Control+Space')
    await expect(text('inspector')).toBeVisible()
    await text('harakat-btn').first().click() // fatha on the selected (first) letter
  }
  await edit()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await expect.poll(docText).toBe('كتاب')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
  await edit()
  await expect(text('correction-suggestion')).toBeVisible({ timeout: 10_000 })
  await expect(text('correction-suggestion')).toContainText('اقتراح من تصحيحاتك السابقة')
  await text('corr-add-dict').click()
  await expect
    .poll(async () =>
      ((await apiGet('/api/dictionary')) as { word_or_phrase: string }[]).some(
        (d) => d.word_or_phrase === 'كتاب'
      )
    )
    .toBe(true)
  await page.keyboard.press('Escape')
})

test('typography: issues are underlined and «توحيد النص» previews and applies selected edits in one step', async () => {
  const src = 'كــــتاب ﻟﻠﻮﻟﺪ جميل'
  await setDoc(src)
  await expect.poll(() => page.locator('.cm-spell').count(), { timeout: 20_000 }).toBeGreaterThan(0)
  await text('toolbar-normalize').click()
  await expect(text('normalize-dialog')).toBeVisible()
  await text('normalize-preview').click()
  await expect(text('normalize-edit')).toHaveCount(2)
  await text('normalize-edit').nth(1).locator('input').uncheck() // keep the presentation forms
  await expect(text('normalize-count')).toContainText('1 من 2')
  await text('normalize-apply').click()
  await expect.poll(docText).toBe('كتاب ﻟﻠﻮﻟﺪ جميل')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await expect.poll(docText).toBe(src)
})

test('readability section reports OSMAN, metrics and jumps to long sentences', async () => {
  const long =
    'ذهب الولد إلى المدرسة في الصباح الباكر وكان الجو جميلا والطيور تغرد على الأشجار العالية في الحديقة الكبيرة القريبة من البيت الذي يسكنه مع أسرته منذ سنوات طويلة جدا. جملة قصيرة.'
  await setDoc(long)
  await text('toggle-stats').click()
  await page.getByLabel('أقصى عدد كلمات للجملة').fill('12')
  await text('readability-run').click()
  await expect(text('readability-panel')).toBeVisible()
  expect(Number(await text('readability-osman').innerText())).toBeGreaterThan(0)
  await expect(text('readability-sentences')).toHaveText('2')
  await text('readability-long').first().click()
  expect((await selectedText()).startsWith('ذهب الولد')).toBe(true)
  await text('toggle-stats').click()
})

test('poetry: document mode toggle persists and the meter of a verse is analysed', async () => {
  await text('poetry-toggle').click()
  await expect(text('poetry-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(async () =>
      Object.entries((await apiGet('/api/settings')) as Record<string, string>).some(
        ([k, v]) => k.startsWith('poetry_mode:') && v === 'true'
      )
    )
    .toBe(true)
  await text('poetry-toggle').click()
  await expect(text('poetry-toggle')).toHaveAttribute('aria-pressed', 'false')

  await setDoc(
    'قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ\nبِسِقْطِ اللِّوَى بَيْنَ الدَّخُولِ فَحَوْمَلِ'
  )
  await text('toggle-poetry-panel').click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await text('poetry-analyze-all').click()
  await expect(text('poetry-meter')).toHaveText('الطويل')
  await expect(text('poetry-feet')).toContainText('فعولن')
  await expect(text('poetry-verse')).toHaveCount(1)
  await text('right-panel-close').click()
})

test('Quran: an uninstalled text shows a one-time hint that opens the settings section', async () => {
  await setDoc('قال الله تعالى في كتابه الكريم: بسم الله الرحمن الرحيم')
  await page.evaluate(() => {
    ;(window as unknown as { __openSettings: string[] }).__openSettings = []
    window.addEventListener('mizaj:open-settings', (e) =>
      (window as unknown as { __openSettings: string[] }).__openSettings.push(
        (e as CustomEvent).detail.section
      )
    )
  })
  const status = (await apiGet('/api/quran/status')) as { installed: boolean }
  test.skip(
    status.installed,
    'Quran text is installed here: hint not shown (read-only behaviour is unit-tested)'
  )
  await expect(text('quran-hint')).toBeVisible({ timeout: 15_000 })
  await text('quran-hint-open').click()
  expect(
    await page.evaluate(() => (window as unknown as { __openSettings: string[] }).__openSettings)
  ).toContain('quran')
  // the banner button now really opens the Quran settings (it used to do nothing)
  await expect(text('quran-settings')).toBeVisible()
  await text('settings-close').click()
  await text('quran-hint-dismiss').click()
  await expect(text('quran-hint')).toHaveCount(0)
})
