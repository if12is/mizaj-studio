import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** Regressions from the v0.4 full QA pass (docs/qa/v0.4-qa-report.md). */
const desktopDir = resolve(__dirname, '../..')
const VERSE_COUNTS =
  '7,286,200,176,120,165,206,75,129,109,123,111,43,52,99,128,111,110,98,135,112,78,118,64,77,227,93,88,69,60,34,30,73,54,45,83,182,88,75,85,54,53,89,59,37,35,38,29,18,45,60,49,62,55,78,96,29,22,24,13,14,11,11,18,12,12,30,52,52,44,28,28,20,56,40,31,50,40,46,42,29,19,36,25,22,17,19,26,30,20,15,21,11,8,8,19,5,8,8,11,11,8,3,9,5,4,7,3,6,3,5,4,5,6'
    .split(',')
    .map(Number)

/** A structurally valid Tanzil `txt-2` file made of SYNTHETIC text (never real Quran text). */
function syntheticTanzil(): string {
  const L = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي'
  const w = (n: number, k: number): string => {
    let s = ''
    for (let i = 0; i < k; i++) {
      s += L[n % 28]
      n = Math.floor(n / 28)
    }
    return s
  }
  const lines: string[] = []
  VERSE_COUNTS.forEach((n, i) => {
    const sura = i + 1
    for (let aya = 1; aya <= n; aya++)
      lines.push(
        `${sura}|${aya}|${w(sura * 7 + aya, 3)}ا ${w(aya * 13 + sura, 3)}ون ${w(sura * 31 + aya * 3, 4)} ${w(aya * 17 + sura * 5, 3)}ين`
      )
  })
  lines.push('', '# Tanzil Quran Text', '# License: Creative Commons Attribution 3.0')
  lines.push('# Copyright (C) 2007-2021 Tanzil Project')
  return lines.join('\n') + '\n'
}

let app: ElectronApplication
let page: Page
let userData: string
let work: string

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
const setDoc = (t: string) =>
  page.evaluate((t2) => {
    const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t2 } })
    v.focus()
  }, t)
const setEnv = (k: string, v: string) =>
  app.evaluate(
    (_, [key, val]) => {
      process.env[key] = val
    },
    [k, v]
  )
const toasts = () => text('toasts')

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-qa04-'))
  work = mkdtempSync(join(tmpdir(), 'mizaj-e2e-qa04-files-'))
  writeFileSync(join(work, 'tanzil.txt'), syntheticTanzil())
  writeFileSync(join(work, 'empty.txt'), '')
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E: '1',
      MIZAJ_E2E_NO_SHELL: '1'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز')
  await text('new-project').click()
  await text('new-project-input').fill('QA')
  await text('new-project-input').press('Enter')
  await expect(text('project-item')).toHaveCount(1)
  await text('new-document').click()
  await text('new-document-input').fill('doc')
  await text('new-document-input').press('Enter')
  await expect(text('doc-title')).toHaveText('doc')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

test('spell checker never flags numbers, digits or Latin tokens', async () => {
  await setDoc(
    'صدر القانون عام 1996 م و ١٩٩٦ و 12.5% و iPhone15 والرقم 2020/05/03 وقال "المادة 14 لسنة 1944" ذهب الولد الى المدرسة'
  )
  await text('toolbar-spell').click()
  await text('toggle-spell-panel').click()
  await expect(text('spell-issue').first()).toBeVisible() // the check ran (الى is a real finding)
  const issues = await text('spell-issue').allInnerTexts()
  expect(issues.length).toBeGreaterThan(0)
  for (const i of issues) expect(i.split('\n')[0]).not.toMatch(/[0-9٠-٩A-Za-z]/)
  // no inline mark sits on a number either
  const marked = await page
    .locator('.cm-content [class*="spell"]')
    .evaluateAll((els) => els.map((e) => e.textContent ?? ''))
  for (const m of marked) expect(m).not.toMatch(/[0-9٠-٩A-Za-z]/)
  await text('right-panel-close').click()
})

test('Quran banner button opens the settings on the Quran tab and installing clears the banner', async () => {
  await setDoc('قال المحامي رااا يااون رباا سباين وبعد ذلك ذهب الولد')
  await expect(text('quran-hint')).toBeVisible()
  await text('quran-hint-open').click()
  await expect(text('quran-settings')).toBeVisible() // used to do nothing
  await expect(text('quran-state')).toHaveText('غير مثبّت')
  await setEnv('MIZAJ_E2E_OPEN_PATH', join(work, 'tanzil.txt'))
  await text('quran-install').click()
  await expect(text('quran-message')).toHaveText('تم تثبيت النص من الملف.')
  await expect(text('quran-state')).toContainText('6236')
  await text('settings-close').click()
  await expect(text('quran-hint')).toBeHidden() // refreshed at once, no edit needed
})

test('a wrong Quran file gives a specific Arabic message, never a raw error', async () => {
  writeFileSync(join(work, 'plain.txt'), 'بسم الله الرحمن الرحيم\n')
  await setEnv('MIZAJ_E2E_OPEN_PATH', join(work, 'plain.txt'))
  await text('open-settings').click()
  await text('tab-quran').click()
  await text('quran-install').click()
  const msg = text('quran-message')
  await expect(msg).toContainText('with aya numbers')
  await expect(msg).toContainText('tanzil.net')
  await text('settings-close').click()
})

test('personal dictionary refuses a form that changes the base letters', async () => {
  await text('open-settings').click()
  await text('tab-dictionary').click()
  await text('dict-new-word').fill('كلب')
  await text('dict-new-form').fill('كِتَابٌ')
  await text('dict-add').click()
  await expect(toasts()).toContainText('نفس حروف الكلمة')
  await expect(text('dict-row')).toHaveCount(0)
  await text('dict-new-word').fill('كتاب')
  await text('dict-new-form').fill('كِتَابٌ')
  await text('dict-add').click()
  await expect(text('dict-row')).toHaveCount(1)
  await text('settings-close').click()
})

test('legal tools: invalid input explains itself in Arabic and copy really works', async () => {
  await text('toggle-legal-panel').click()
  await text('legal-tab-tafqeet').click()
  await text('tafqeet-amount').fill('abc')
  await text('tafqeet-run').click()
  await expect(toasts()).toContainText('المبلغ يجب أن يكون رقماً')
  await text('tafqeet-amount').fill('1250.50')
  await text('tafqeet-run').click()
  await expect(text('tafqeet-result')).toBeVisible()
  await text('tafqeet-copy').click()
  await expect(toasts()).toContainText('تم النسخ.')
  await expect(toasts()).not.toContainText('تعذر النسخ')
})

test('importing an empty text file says so instead of creating an empty document', async () => {
  await setEnv('MIZAJ_E2E_OPEN_PATH', join(work, 'empty.txt'))
  await text('file-menu').click()
  await text('file-import').click()
  await expect(toasts()).toContainText('الملف فارغ')
})
