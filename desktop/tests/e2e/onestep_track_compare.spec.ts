import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
const MARKS = /[ً-ْ]/g
let app: ElectronApplication
let page: Page
let userData: string
let work: string

const t = (id: string) => page.getByTestId(id)
type CM = {
  cmView: {
    view: { state: { doc: { toString(): string; length: number } }; dispatch(s: unknown): void }
  }
}
const docText = () =>
  page.evaluate(() =>
    (document.querySelector('.cm-content') as unknown as CM).cmView.view.state.doc.toString()
  )
const setDoc = (text: string) =>
  page.evaluate((t2) => {
    const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: t2 },
      selection: { anchor: 0 }
    })
  }, text)
const stub = (key: 'SAVE' | 'OPEN' | 'DIR', value: string) =>
  app.evaluate(
    (_, [k, v]) => {
      process.env[`MIZAJ_E2E_${k}_PATH`] = v
    },
    [key, value]
  )
function docxXml(path: string): string {
  return execFileSync('unzip', ['-p', path, 'word/document.xml'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26
  })
}
async function setSetting(testid: string, value: string): Promise<void> {
  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await t(testid).selectOption(value)
  await t('settings-close').click()
  await expect(t('settings-modal')).toHaveCount(0)
}

const SRC = 'محكمة ابو حمص ، فى ان المدعي اقام الدعوى .'

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-os-'))
  work = mkdtempSync(join(tmpdir(), 'mizaj-e2e-os-work-'))
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
  await t('new-project-input').fill('خطوة واحدة')
  await t('new-project-input').press('Enter')
  await t('new-document').first().click()
  await t('new-document-input').fill('مستند الخطوة')
  await t('new-document-input').press('Enter')
  await expect(t('doc-title')).toHaveText('مستند الخطوة')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

test('one step: base-letter fixes go through the review dialog by default, then ONE summary', async () => {
  await setDoc(SRC)
  await t('toolbar-onestep').click()
  const dlg = t('proofread-dialog')
  await expect(dlg).toBeVisible()
  // punctuation is pre-accepted (applied directly); hamza / spelling / ya are left for the user
  await expect(
    dlg.locator('[data-category="punctuation"] [data-testid="proofread-accept"]').first()
  ).toHaveAttribute('aria-pressed', 'true')
  for (const c of ['hamza', 'spelling', 'ya']) {
    const first = dlg.locator(`[data-category="${c}"] [data-testid="proofread-accept"]`).first()
    if (await first.count()) await expect(first).toHaveAttribute('aria-pressed', 'false')
  }
  for (const b of await dlg.locator('[data-testid^="proofread-accept-all-"]').all()) await b.click()
  await t('proofread-apply-run').click()
  await expect(t('onestep-summary')).toBeVisible()
  const line = await t('onestep-summary-text').innerText()
  expect(line).toMatch(/^صُحّح: .+ — شُكّلت .+ كلمة — مشكوك فيها: .+/)
  await expect(page.getByTestId('onestep-summary')).toHaveCount(1) // a single dialog
  const text = await docText()
  expect((text.match(MARKS) ?? []).length).toBeGreaterThan(3)
  expect(text.replace(MARKS, '')).not.toContain('فى ان')
  for (const id of ['onestep-review', 'onestep-export', 'onestep-close-btn'])
    await expect(t(id)).toBeVisible()
  await t('onestep-close-btn').click()
  await expect(t('onestep-summary')).toHaveCount(0)
})

test('compare view: amber proofreading, emerald diacritics, legend, revert one word', async () => {
  await t('toggle-diff').click()
  await expect(t('diff-view')).toBeVisible()
  await expect(t('diff-legend')).toContainText('تشكيل فقط')
  const proof = t('diff-change').and(page.locator('[data-kind="proof"]'))
  const diac = t('diff-change').and(page.locator('[data-kind="diac"]'))
  expect(await proof.count()).toBeGreaterThan(0)
  expect(await diac.count()).toBeGreaterThan(0)
  const colour = (loc: typeof proof) =>
    loc.first().evaluate((e) => getComputedStyle(e).backgroundColor)
  expect(await colour(proof)).not.toBe(await colour(diac))
  // both sides live in ONE scroll container: they scroll together
  await expect(t('diff-scroll')).toHaveCount(1)
  const before = await docText()
  const nProof = await proof.count()
  const word = (await proof.first().innerText()).trim()
  await proof.first().click()
  await expect.poll(async () => (await proof.count()) < nProof).toBe(true)
  const after = await docText()
  expect(after).not.toBe(before)
  expect(after.length).toBeLessThan(before.length + 20)
  await expect(t('diff-view')).toContainText(word.length ? word.slice(0, 1) : '')
  await t('toggle-diff').click()
  await expect(t('diff-view')).toHaveCount(0)
})

test('Word export with tracked changes: real w:ins / w:del by «مِزَاج», scope options', async () => {
  await setDoc(SRC)
  await t('toolbar-onestep').click()
  await expect(t('proofread-dialog')).toBeVisible()
  for (const b of await t('proofread-dialog')
    .locator('[data-testid^="proofread-accept-all-"]')
    .all())
    await b.click()
  await t('proofread-apply-run').click()
  await t('onestep-close-btn').click()

  const both = join(work, 'both.docx')
  await stub('SAVE', both)
  await t('file-menu').click()
  await t('file-export-docx-track-edits').click()
  await expect(t('tracked-dialog')).toBeVisible()
  await expect(t('tracked-scope-both')).toBeChecked()
  await expect(t('tracked-per-word')).toBeChecked()
  await t('tracked-confirm').click()
  await expect.poll(() => existsSync(both), { timeout: 60_000 }).toBe(true)
  const xml = docxXml(both)
  const ins = xml.match(/<w:ins /g) ?? []
  const del = xml.match(/<w:del /g) ?? []
  expect(ins.length).toBeGreaterThan(2)
  expect(del.length).toBeGreaterThanOrEqual(ins.length) // a pure deletion has no w:ins
  expect(xml).toContain('w:author="مِزَاج"')

  const proofOnly = join(work, 'proof.docx')
  await stub('SAVE', proofOnly)
  await t('file-menu').click()
  await t('file-export-docx-track-edits').click()
  await t('tracked-scope-proofread').check()
  await t('tracked-confirm').click()
  await expect.poll(() => existsSync(proofOnly), { timeout: 60_000 }).toBe(true)
  const p = docxXml(proofOnly)
  const insText = (p.match(/<w:ins [\s\S]*?<\/w:ins>/g) ?? [])
    .flatMap((x) => x.match(/<w:t [^>]*>[^<]*<\/w:t>/g) ?? [])
    .join('')
  expect((p.match(/<w:ins /g) ?? []).length).toBeGreaterThan(0)
  expect(insText.match(MARKS) ?? []).toHaveLength(0) // proofreading only: no diacritics tracked
  expect((p.match(/<w:ins /g) ?? []).length).toBeLessThan(ins.length)
})

test('one step with the setting ON applies base-letter fixes without the review dialog', async () => {
  await setSetting('setting-onestep-auto-base', 'true')
  await setDoc(SRC)
  await t('toolbar-onestep').click()
  await expect(t('onestep-summary')).toBeVisible()
  await expect(t('proofread-dialog')).toHaveCount(0)
  expect((await docText()).replace(MARKS, '')).not.toContain('فى ان')
  await t('onestep-close-btn').click()
  await setSetting('setting-onestep-auto-base', 'false')
})
