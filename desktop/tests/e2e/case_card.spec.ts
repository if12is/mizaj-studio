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
type CM = {
  cmView: {
    view: {
      state: {
        doc: { toString(): string; length: number }
        selection: { main: { from: number; to: number } }
        sliceDoc(a: number, b: number): string
      }
      dispatch(s: unknown): void
    }
  }
}
const selected = () =>
  page.evaluate(() => {
    const s = (document.querySelector('.cm-content') as unknown as CM).cmView.view.state
    return s.sliceDoc(s.selection.main.from, s.selection.main.to)
  })
const setDoc = (text: string) =>
  page.evaluate((t2) => {
    const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t2 } })
  }, text)

const MEMO = [
  'محكمة أبو حمص الكلية',
  'الدائرة الثالثة مدني كلي',
  'في الدعوى رقم 624 لسنة 2026 مدني كلي',
  'المحدد لنظرها جلسة 30/7/2026',
  'المدعي: أحمد محمد علي',
  'السيد/ وزير العدل وآخرين بصفتهم مدعى عليهم',
  'الطلبات',
  'الحكم بإلغاء أمر التقدير مع المصروفات.'
].join('\n')

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-card-'))
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
  await t('new-project').click()
  await t('new-project-input').fill('مشروع البطاقة')
  await page.keyboard.press('Enter')
  await t('new-document').first().click()
  await t('new-document-input').fill('بطاقة')
  await page.keyboard.press('Enter')
  await expect(t('doc-title')).toHaveText('بطاقة')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('card appears (debounced) with the extracted fields', async () => {
  await expect(t('case-card')).toHaveCount(0)
  await setDoc(MEMO)
  await expect(t('case-card')).toBeVisible({ timeout: 10_000 })
  const keys = await page
    .locator('[data-testid=case-card-field]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
  expect(keys).toEqual(
    expect.arrayContaining(['case_number', 'court', 'session_dates', 'parties', 'relief'])
  )
})

test('clicking a field jumps to its occurrence', async () => {
  const row = page.locator('[data-testid=case-card-field][data-key=case_number]')
  await row.getByTestId('case-card-jump').click()
  await expect.poll(selected).toBe('624 لسنة 2026')
  await page
    .locator('[data-testid=case-card-field][data-key=session_dates]')
    .getByTestId('case-card-jump')
    .click()
  await expect.poll(selected).toBe('30/7/2026')
})

test('copy one field and copy all', async () => {
  await page
    .locator('[data-testid=case-card-field][data-key=court]')
    .getByTestId('case-card-copy')
    .click()
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('محكمة أبو حمص الكلية')
  await t('case-card-copy-all').click()
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('رقم الدعوى: 624 لسنة 2026')
})

test('updates when the document changes', async () => {
  await setDoc(MEMO.replace('624', '777'))
  await expect(
    page
      .locator('[data-testid=case-card-field][data-key=case_number]')
      .getByTestId('case-card-jump')
  ).toHaveText('777 لسنة 2026', { timeout: 10_000 })
})

test('collapse and hide (hidden state is remembered for the document)', async () => {
  await t('case-card-collapse').click()
  await expect(t('case-card-field')).toHaveCount(0)
  await expect(t('case-card-summary')).toBeVisible()
  await t('case-card-collapse').click()
  await expect(t('case-card-field').first()).toBeVisible()
  await t('case-card-hide').click()
  await expect(t('case-card')).toHaveCount(0)
  await t('case-card-toggle').click()
  await expect(t('case-card')).toBeVisible({ timeout: 10_000 })
})

test('legal checks list the date / article warnings with a jump', async () => {
  await setDoc('حرر العقد بتاريخ 31/2/2026 وفق المادة ( 3 / 1 ) من القانون المدني')
  await t('toggle-legal-panel').click()
  await t('legal-tab-checks').click()
  await t('legal-check-run').click()
  const group = page.locator('[data-testid=legal-checks] section[data-group=refs]')
  await expect(group).toBeVisible()
  await expect(group.getByTestId('legal-issue')).toHaveCount(2)
  await group.locator('[data-type=date_impossible] [data-testid=legal-jump]').click()
  await expect.poll(selected).toBe('31/2/2026')
  // suggestions only: the text is untouched and no apply button is offered
  await expect(group.getByTestId('legal-apply')).toHaveCount(0)
})
