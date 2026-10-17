import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
const fixtures = resolve(desktopDir, '../backend/tests/fixtures')
const MARKS = /[ً-ْ]/g

let app: ElectronApplication
let page: Page
let userData: string
let work: string

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
      focus(): void
    }
  }
}
const docText = () =>
  page.evaluate(() =>
    (document.querySelector('.cm-content') as unknown as CM).cmView.view.state.doc.toString()
  )
const selected = () =>
  page.evaluate(() => {
    const s = (document.querySelector('.cm-content') as unknown as CM).cmView.view.state
    return s.sliceDoc(s.selection.main.from, s.selection.main.to)
  })
const setDoc = (text: string) =>
  page.evaluate((t2) => {
    const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: t2 },
      selection: { anchor: 0 }
    })
    v.focus()
  }, text)
/** Point a native-dialog stub (read by the main process on every call) at a path. */
const stub = (key: 'SAVE' | 'OPEN' | 'DIR', value: string) =>
  app.evaluate(
    (_, [k, v]) => {
      process.env[`MIZAJ_E2E_${k}_PATH`] = v
    },
    [key, value]
  )
const api = <T = unknown>(method: string, path: string, body?: unknown): Promise<T> =>
  page.evaluate(
    async ([m, p, b]) => {
      const cfg = await (
        window as unknown as { mizajAPI: { getBackendConfig(): Promise<{ baseUrl: string }> } }
      ).mizajAPI.getBackendConfig()
      const r = await fetch(`${cfg.baseUrl}${p as string}`, {
        method: m as string,
        headers: b ? { 'Content-Type': 'application/json' } : undefined,
        body: b ? JSON.stringify(b) : undefined
      })
      return r.status === 204 ? null : await r.json()
    },
    [method, path, body]
  ) as Promise<T>
function docxXml(path: string): string {
  expect(readFileSync(path).subarray(0, 2).toString('latin1')).toBe('PK')
  return execFileSync('unzip', ['-p', path, 'word/document.xml'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26
  })
}
async function newDocument(title: string): Promise<void> {
  await t('new-document').first().click()
  await t('new-document-input').fill(title)
  await page.keyboard.press('Enter')
  await expect(t('doc-title')).toHaveText(title)
}
async function openFileMenu(item: string): Promise<void> {
  await t('file-menu').click()
  await t(item).click()
}
async function openSettings(tab: string): Promise<void> {
  if (!(await t('settings-modal').isVisible())) await t('open-settings').click()
  await t(`tab-${tab}`).click()
}
const closeSettings = async (): Promise<void> => {
  if (await t('settings-modal').isVisible()) await t('settings-close').click()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-b-'))
  work = mkdtempSync(join(tmpdir(), 'mizaj-e2e-b-work-'))
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
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
  await t('new-project').click()
  await t('new-project-input').fill('مشروع الاختبار')
  await page.keyboard.press('Enter')
  await newDocument('عقد تجريبي')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

// ---------------------------------------------------------------- export / import
test('File menu: export TXT writes the editor text', async () => {
  await setDoc('كتاب جميل\nسطر ثان')
  const out = join(work, 'out.txt')
  await stub('SAVE', out)
  await openFileMenu('file-export-txt')
  await expect.poll(() => existsSync(out), { timeout: 30_000 }).toBe(true)
  expect(readFileSync(out, 'utf8').replace(/\r\n/g, '\n')).toBe('كتاب جميل\nسطر ثان')
  await expect(page.locator('[data-testid="toasts"] [data-kind="success"]').last()).toBeVisible()
})

test('File menu: DOCX with track changes contains w:ins', async () => {
  const out = join(work, 'tracked.docx')
  await stub('SAVE', out)
  await stub('OPEN', join(fixtures, 'sample_ar.docx')) // the original Word file to compare against
  await openFileMenu('file-export-docx-track')
  await expect.poll(() => existsSync(out), { timeout: 60_000 }).toBe(true)
  const xml = docxXml(out)
  expect(xml).toContain('<w:ins ')
  expect((xml.match(MARKS) ?? []).length).toBeGreaterThan(3)
})

test('File menu: import TXT creates a document; scanned image explains missing Tesseract', async () => {
  const txt = join(work, 'مستورد.txt')
  writeFileSync(txt, 'نص مستورد من ملف', 'utf8')
  await stub('OPEN', txt)
  await openFileMenu('file-import')
  await expect(t('doc-title')).toHaveText('مستورد')
  await expect.poll(docText).toBe('نص مستورد من ملف')

  const tools = await api<{ tesseract: { detected: boolean } }>('GET', '/api/tools')
  if (tools.tesseract.detected) test.skip(true, 'Tesseract is installed here; OCR failure path n/a')
  const png = join(work, 'scan.png')
  writeFileSync(
    png,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  )
  await stub('OPEN', png)
  await openFileMenu('file-import')
  await expect(t('ocr-failure')).toBeVisible()
  await expect(t('ocr-failure-text')).toContainText('Tesseract')
  await expect(t('ocr-install-hint')).toBeVisible()
  await t('ocr-failure-dismiss').click()
})

test('batch dialog processes a folder of two TXT files and opens the output', async () => {
  const inDir = join(work, 'in')
  const outDir = join(work, 'out-batch')
  mkdirSync(inDir)
  writeFileSync(join(inDir, 'a.txt'), 'ذهب الولد إلى المدرسة', 'utf8')
  writeFileSync(join(inDir, 'b.txt'), 'كتاب جميل', 'utf8')
  await openFileMenu('file-batch')
  await expect(t('batch-dialog')).toBeVisible()
  await stub('DIR', inDir)
  await t('batch-pick-input').click()
  await expect(t('batch-input-dir')).toHaveValue(inDir)
  await stub('DIR', outDir)
  await t('batch-pick-output').click()
  for (const f of ['docx', 'md', 'srt', 'epub']) await t(`batch-format-${f}`).uncheck()
  await t('batch-start').click()
  await expect(t('batch-status')).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
  expect(readdirSync(outDir).sort()).toEqual(['a.txt', 'b.txt'])
  expect((readFileSync(join(outDir, 'a.txt'), 'utf8').match(MARKS) ?? []).length).toBeGreaterThan(2)
  expect(readFileSync(join(inDir, 'a.txt'), 'utf8')).toBe('ذهب الولد إلى المدرسة') // untouched
  await t('batch-open-output').click()
  const log = await app.evaluate(
    () =>
      (globalThis as unknown as { __mizajShellLog: { kind: string; target: string }[] })
        .__mizajShellLog
  )
  expect(log).toContainEqual({ kind: 'path', target: outDir })
  await t('batch-dialog-close').click()
})

// ---------------------------------------------------------------- packs & backup
test('pack export -> preview -> conflict choice -> apply -> undo (dictionary entry)', async () => {
  const entry = await api<{ id: number }>('POST', '/api/dictionary', {
    word_or_phrase: 'كتاب',
    diacritized_form: 'كِتَابٌ'
  })
  await openSettings('packs')
  for (const k of ['glossary', 'templates']) await t(`pack-kind-${k}`).uncheck()
  await t('pack-name').fill('حزمة اختبار')
  await t('pack-license').fill('')
  await t('pack-export').click()
  await expect(t('pack-message')).toContainText('الترخيص') // license is required, nothing written yet
  await t('pack-license').fill('CC0-1.0')
  const pack = join(work, 'test.mizajpack')
  await stub('SAVE', pack)
  await t('pack-export').click()
  await expect.poll(() => existsSync(pack), { timeout: 30_000 }).toBe(true)
  await expect(t('pack-message')).toContainText('تم تصدير الحزمة')

  // the entry is removed locally, so the import will ADD it
  await api('DELETE', `/api/dictionary/${entry.id}`)
  await stub('OPEN', pack)
  await t('pack-import').click()
  await expect(t('pack-preview')).toBeVisible()
  await expect(t('pack-preview-license')).toHaveText('CC0-1.0')
  await expect(t('pack-group-dictionary-adds')).toBeVisible()
  await t('pack-apply-v2').click()
  await expect(t('pack-message')).toContainText('تم الاستيراد')
  let dict = await api<{ word_or_phrase: string; diacritized_form: string }[]>(
    'GET',
    '/api/dictionary'
  )
  expect(dict.find((d) => d.word_or_phrase === 'كتاب')?.diacritized_form).toBe('كِتَابٌ')
  await expect(t('pack-history-item').first()).toHaveAttribute('data-status', 'applied')

  // undo restores the previous state (entry gone again)
  await t('pack-undo').first().click()
  await expect(t('pack-history-item').first()).toHaveAttribute('data-status', 'undone')
  dict = await api('GET', '/api/dictionary')
  expect(dict.find((d) => d.word_or_phrase === 'كتاب')).toBeUndefined()

  // a locked local entry that differs is a conflict: keep by default, override on request
  await api('POST', '/api/dictionary', { word_or_phrase: 'كتاب', diacritized_form: 'كُتُبٌ' })
  await t('pack-import').click()
  await expect(t('pack-group-dictionary-conflicts')).toBeVisible()
  await expect(t('pack-item-conflicts').first()).toContainText('مقفل')
  await t('pack-choice-override').first().check()
  await t('pack-apply-v2').click()
  await expect(t('pack-message')).toContainText('تم الاستيراد')
  dict = await api('GET', '/api/dictionary')
  expect(dict.find((d) => d.word_or_phrase === 'كتاب')?.diacritized_form).toBe('كِتَابٌ')
  await closeSettings()
})

test('backup export then inspect; restore needs explicit confirmation', async () => {
  const bk = join(work, 'b.mizajbackup')
  await openSettings('backup')
  await stub('SAVE', bk)
  await t('backup-export').click()
  await expect.poll(() => existsSync(bk), { timeout: 60_000 }).toBe(true)
  await expect(t('backup-message')).toContainText('تم إنشاء النسخة الاحتياطية')
  await stub('OPEN', bk)
  await t('backup-choose').click()
  await expect(t('backup-info')).toBeVisible()
  expect(Number(await t('backup-files').innerText())).toBeGreaterThan(0)
  await expect(t('backup-restore')).toBeDisabled()
  await t('backup-confirm').check()
  await expect(t('backup-restore')).toBeEnabled() // not clicked: it would replace the live data
  await closeSettings()
})

// ---------------------------------------------------------------- online & Quran
test('online switches default to off and the app made no network requests', async () => {
  await openSettings('online')
  for (const k of ['resources', 'ollama', 'languagetool']) {
    await expect(t(`switch-online-${k}`)).not.toBeChecked()
    await expect(t(`leaves-online-${k}`)).toContainText('ما يغادر جهازك')
  }
  await expect(t('online-log-empty')).toBeVisible()
  const st = await api<{
    switches: Record<string, boolean>
    recent_requests: unknown[]
  }>('GET', '/api/online/status')
  expect(Object.values(st.switches)).toEqual([false, false, false])
  expect(st.recent_requests).toEqual([])

  // resources catalog renders; downloads need the switch AND a license acceptance
  await expect(t('resource-item').first()).toBeVisible()
  expect(await t('resource-item').count()).toBeGreaterThanOrEqual(3)
  await expect(page.locator('[data-testid=resource-item][data-id=ayaspell-ar]')).toBeVisible()
  const dl = page.locator(
    '[data-testid=resource-item][data-id=ayaspell-ar] [data-testid=resource-download]'
  )
  await expect(dl).toBeDisabled()
  await expect(t('resource-license').first()).toBeVisible()
  await expect(t('tool-tesseract')).toBeVisible()
  await expect(t('tools-refresh')).toBeEnabled()
  await t('tool-tesseract-link').click()
  const shellLog = await app.evaluate(
    () =>
      (globalThis as unknown as { __mizajShellLog: { kind: string; target: string }[] })
        .__mizajShellLog
  )
  expect(shellLog.some((e) => e.kind === 'external' && e.target.startsWith('https://'))).toBe(true)

  // turning one on is explicit and persisted
  await t('switch-online-ollama').check()
  await expect
    .poll(
      async () =>
        (await api<{ switches: Record<string, boolean> }>('GET', '/api/online/status')).switches
          .online_ollama
    )
    .toBe(true)
  await t('switch-online-ollama').uncheck()
  await expect
    .poll(
      async () =>
        (await api<{ switches: Record<string, boolean> }>('GET', '/api/online/status')).switches
          .online_ollama
    )
    .toBe(false)
  const after = await api<{ recent_requests: unknown[] }>('GET', '/api/online/status')
  expect(after.recent_requests).toEqual([])
})

test('Quran tab: status, attribution and the download stays disabled while offline', async () => {
  await t('tab-quran').click()
  await expect(t('quran-state')).toContainText('غير مثبّت')
  await expect(t('quran-attribution')).toContainText('Tanzil')
  await expect(t('quran-download')).toBeDisabled()
  await expect(t('quran-download-off')).toBeVisible()
  await expect(t('quran-tanzil-link')).toHaveText('https://tanzil.net/download/')
  await closeSettings()
  await t('settings-modal').waitFor({ state: 'detached' })
  await t('open-settings').click()
  await t('open-about').click()
  await expect(t('about-quran-attribution')).toContainText('Tanzil')
  await t('about-close').click()
  await closeSettings()
})

// ---------------------------------------------------------------- legal v2
test('lint: issues are grouped and jump selects the flagged text', async () => {
  await newDocument('فحص الصياغة')
  await setDoc('يلتزم الطرف الأول بدفع مبلغ 5000 ريال و/أو يجب على الطرف الثاني التسليم.')
  await t('toggle-legal-panel').click()
  await t('legal-tab-lint').click()
  await t('lint-doc-type').selectOption('legal_memo')
  await t('lint-run').click()
  await expect(t('lint-issue').first()).toBeVisible()
  await expect(page.locator('[data-testid=lint-group][data-rule=and_or]')).toBeVisible()
  await expect(t('lint-modality').first()).toBeVisible()
  await expect(t('lint-structure-missing').first()).toBeVisible()
  await page
    .locator('[data-testid=lint-group][data-rule=and_or] [data-testid=lint-jump]')
    .first()
    .click()
  await expect.poll(selected).toBe('و/أو')
})

test('citations: a format suggestion is applied as a single safe edit', async () => {
  await setDoc('وفق المادة 5 من النظام')
  await t('legal-tab-citations').click()
  await t('cit-run').click()
  await expect(t('cit-suggestion').first()).toBeVisible()
  await t('cit-apply').first().click()
  await expect.poll(docText).toBe('وفق المادة (5) من النظام')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await expect.poll(docText).toBe('وفق المادة 5 من النظام')
})

test('redaction: preview, apply as one undo step, and save a redacted copy', async () => {
  const original = 'اتصل على 0501234567 أو راسل a@b.com للتواصل'
  await setDoc(original)
  await t('legal-tab-redact').click()
  await t('redact-run').click()
  await expect(t('redact-item')).toHaveCount(2)
  await expect(t('redact-confidence').first()).toBeVisible()
  await expect(t('redact-map-row').first()).toBeVisible()

  // apply to the open document: one transaction
  await t('redact-apply').click()
  await expect.poll(docText).toContain('[هاتف 1]')
  expect(await docText()).toContain('[بريد 1]')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await expect.poll(docText).toBe(original)

  // redacted copy: new document, original untouched
  await t('redact-run').click()
  await expect(t('redact-item')).toHaveCount(2)
  await t('redact-save-copy').click()
  await expect(t('doc-title')).toHaveText('فحص الصياغة (مُخفى)')
  await expect.poll(docText).toBe('اتصل على [هاتف 1] أو راسل [بريد 1] للتواصل')
  await page
    .getByTestId('document-item')
    .filter({ hasText: /^فحص الصياغة$/ })
    .click()
  await expect(t('doc-title')).toHaveText('فحص الصياغة')
  await expect.poll(docText).toBe(original)
})

test('compare two documents side by side with changed words highlighted', async () => {
  await newDocument('نسخة ب')
  await setDoc('يلتزم الطرف الأول بدفع مبلغ ألفي ريال في الشهر.')
  await newDocument('نسخة أ')
  await setDoc('يلتزم الطرف الأول بدفع مبلغ ألف ريال في الشهر.')
  await t('legal-tab-compare').click()
  await expect(t('right-panel')).toBeVisible()
  const idB = await page.evaluate(() => {
    const opts = [
      ...document.querySelectorAll('[data-testid=cmp-src-b] option')
    ] as HTMLOptionElement[]
    return opts.find((o) => o.textContent?.includes('نسخة ب'))?.value ?? ''
  })
  expect(idB).toMatch(/^doc:\d+$/)
  // saved content is what the backend compares by id; wait for autosave through a flush trigger
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await t('cmp-src-b').selectOption(idB)
  await expect
    .poll(async () => {
      const d = await api<{ raw_content: string }>('GET', `/api/documents/${idB.slice(4)}`)
      return d.raw_content
    })
    .toContain('ألفي')
  await t('cmp-run').click()
  await expect(t('cmp-row').first()).toBeVisible()
  await expect(page.locator('[data-testid=cmp-category][data-category=amounts]')).toBeVisible()
  await expect(t('cmp-side-a').first().locator('[data-kind=change]')).toHaveText('ألف')
  await expect(t('cmp-side-b').first().locator('[data-kind=change]')).toHaveText('ألفي')
  await expect(t('cmp-show-format')).not.toBeChecked() // format-only differences hidden by default
})

test('templates: the category filter offers every category after filtering', async () => {
  await t('legal-tab-templates').click()
  const options = () => page.locator('[data-testid=tpl-category] option')
  await expect.poll(() => options().count()).toBeGreaterThan(3)
  const before = await options().count()
  await t('tpl-category').selectOption({ index: 1 })
  await expect(t('tpl-item').first()).toBeVisible()
  expect(await options().count()).toBe(before)
})
