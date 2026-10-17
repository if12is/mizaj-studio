import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
const fixtures = resolve(desktopDir, '../backend/tests/fixtures')
const MARKS = /[ً-ْ]/g

let app: ElectronApplication
let page: Page
let userData: string
let outDir: string // exports must go OUTSIDE userData (the backend refuses writes into its data dir)
let exportPath: string

const text = (id: string) => page.getByTestId(id)
const docText = () =>
  page.evaluate(() =>
    (
      document.querySelector('.cm-content') as unknown as {
        cmView: { view: { state: { doc: { toString(): string } } } }
      }
    ).cmView.view.state.doc.toString()
  )

/** Run the real drop handler: dispatch a drop whose File has an on-disk path. */
async function dropDocx(name: string): Promise<void> {
  const path = join(fixtures, name)
  await page.evaluate((p) => {
    // webUtils.getPathForFile returns '' for synthetic files; DropOverlay then falls
    // back to file.path, which we set to the real fixture path.
    const f = new File([new Uint8Array([80, 75])], p.split('/').pop() as string)
    Object.defineProperty(f, 'path', { value: p })
    const dt = new DataTransfer()
    dt.items.add(f)
    const ev = (t: string) =>
      new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev('dragenter'))
    document.body.dispatchEvent(ev('drop'))
  }, path)
}

function sidecarPids(): number[] {
  const log = readFileSync(join(userData, 'logs', 'mizaj-main.log'), 'utf8')
  return [...log.matchAll(/sidecar started pid=(\d+)/g)].map((m) => Number(m[1]))
}

function docxXml(path: string): string {
  const head = readFileSync(path).subarray(0, 2).toString('latin1')
  expect(head).toBe('PK')
  return execFileSync('unzip', ['-p', path, 'word/document.xml'], {
    encoding: 'utf8',
    maxBuffer: 1 << 26
  })
}

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-'))
  outDir = mkdtempSync(join(tmpdir(), 'mizaj-e2e-out-'))
  exportPath = join(outDir, 'exported.docx')
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E: '1',
      MIZAJ_E2E_SAVE_PATH: exportPath
    }
  })
  page = await app.firstWindow()
  // transitions would race instant visibility checks; motion has its own spec (motion.spec.ts)
  await page.emulateMedia({ reducedMotion: 'reduce' })
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

test.describe.configure({ mode: 'serial' })

test('sidecar starts and the status bar says ready', async () => {
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز')
  await expect(text('statusbar')).toBeVisible()
})

test('create a project to import into', async () => {
  await text('new-project').click()
  await text('new-project-input').fill('مشروع E2E')
  await text('new-project-input').press('Enter')
  await expect(text('project-item')).toHaveCount(1)
})

for (const name of ['sample_ar.docx', 'sample_mixed.docx']) {
  test(`import ${name}, diacritize, edit a mark, export`, async () => {
    await expect(text('progress-bar')).toBeHidden() // previous run's 'done' bar has gone
    await dropDocx(name)
    await expect(text('drop-stats')).toBeVisible()
    await text('drop-diacritize').click()
    await expect(text('doc-title')).toHaveText(name.replace('.docx', ''))

    // run finishes: progress bar reaches done / 100%
    await expect(text('progress-percent')).toHaveText('100%')
    await expect.poll(async () => (await docText()).match(MARKS)?.length ?? 0).toBeGreaterThan(10)
    const t = await docText()
    if (name === 'sample_mixed.docx') {
      expect(t).toContain('iPhone 16 Pro')
      expect(t).toContain('calculate_total(price=100)')
      expect(t).toContain('https://example.com/store')
    }

    // inspector on the first Arabic word: change one letter's marks
    await page.evaluate(() => {
      const v = (
        document.querySelector('.cm-content') as unknown as {
          cmView: {
            view: {
              state: { doc: { toString(): string } }
              dispatch(s: unknown): void
              focus(): void
            }
          }
        }
      ).cmView.view
      const i = v.state.doc.toString().search(/[ء-ي]/)
      v.dispatch({ selection: { anchor: i + 1 } })
      v.focus()
    })
    const before = await docText()
    await page.keyboard.press('Control+Space')
    await expect(text('inspector')).toBeVisible()
    await text('harakat-btn').nth(2).click() // kasra on the selected (first) letter
    await expect.poll(docText).not.toBe(before)
    const after = await docText()
    expect(after.replace(MARKS, '')).toBe(before.replace(MARKS, ''))
    await page.keyboard.press('Escape')

    // the manual edit is counted, shown in the stats panel and persisted per document
    if ((await text('stats-panel').count()) === 0) await text('toggle-stats').click()
    await expect(text('stat-manual')).toHaveText('1')
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const cfg = await (
            window as unknown as {
              mizajAPI: { getBackendConfig(): Promise<{ baseUrl: string; token: string }> }
            }
          ).mizajAPI.getBackendConfig()
          const all = (await (
            await fetch(`${cfg.baseUrl}/api/settings`, { headers: { 'X-Mizaj-Token': cfg.token } })
          ).json()) as Record<string, string>
          return Object.entries(all)
            .filter(([k]) => k.startsWith('manual_edits:'))
            .map(([, v]) => JSON.parse(v).count)
        })
      )
      .toContain(1)

    // export through the (stubbed) native save dialog
    rmSync(exportPath, { force: true })
    await text('export-docx').click()
    await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true)
    await expect(page.locator('[data-testid="toasts"] [data-kind="success"]').last()).toBeVisible()
    const xml = docxXml(exportPath)
    expect((xml.match(MARKS) ?? []).length).toBeGreaterThan(10)
    if (name === 'sample_mixed.docx') expect(xml).toContain('iPhone 16 Pro')
  })
}

// The backend generates a fresh RTL .docx for documents without a source file.
test('export a document that was not imported from Word', async () => {
  await text('new-document').first().click()
  await text('new-document-input').fill('مستند يدوي')
  await text('new-document-input').press('Enter')
  await page.getByTestId('document-item').filter({ hasText: 'مستند يدوي' }).click()
  await expect(text('doc-title')).toHaveText('مستند يدوي')
  await page.evaluate(() => {
    const v = (
      document.querySelector('.cm-content') as unknown as {
        cmView: { view: { state: { doc: { length: number } }; dispatch(s: unknown): void } }
      }
    ).cmView.view
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'كتاب جميل' } })
  })
  await text('toolbar-tashkeel').click()
  await expect.poll(async () => (await docText()).match(MARKS)?.length ?? 0).toBeGreaterThan(3)
  rmSync(exportPath, { force: true })
  await text('export-docx').click()
  await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true)
  const xml = docxXml(exportPath)
  expect((xml.match(MARKS) ?? []).length).toBeGreaterThan(3)
  expect(xml).toContain('w:bidi')
})

test('settings shows the models version section', async () => {
  await text('open-settings').click()
  await expect(text('settings-modal')).toBeVisible()
  await expect(text('pack-version')).toBeVisible()
  await expect(text('pack-apply')).toBeVisible()
  // updater: toggle present; manual check explains that updates need the installed build
  await expect(text('setting-auto-update')).toBeChecked()
  await text('update-check').click()
  await expect(text('update-status')).toHaveText('التحديثات متاحة فقط في النسخة المثبتة')
  await text('settings-close').click()
})

// ---------------------------------------------------------------- Phase 7 batch 2
const setDocText = (t: string, cursorAtEnd = true) =>
  page.evaluate(
    ([t2, end]) => {
      const v = (
        document.querySelector('.cm-content') as unknown as {
          cmView: {
            view: { state: { doc: { length: number } }; dispatch(s: unknown): void; focus(): void }
          }
        }
      ).cmView.view
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: t2 },
        selection: { anchor: end ? (t2 as string).length : 0 }
      })
      v.focus()
    },
    [t, cursorAtEnd] as const
  )

test('new document for the phase 7 tools', async () => {
  await text('new-document').first().click()
  await text('new-document-input').fill('مستند قانوني')
  await text('new-document-input').press('Enter')
  await page.getByTestId('document-item').filter({ hasText: 'مستند قانوني' }).click()
  await expect(text('doc-title')).toHaveText('مستند قانوني')
})

test('spelling: underline appears and accepting a suggestion fixes the word', async () => {
  await setDocText('ذهبت الى المدرسة')
  const err = page.locator('.cm-spell-error').first()
  await expect(err).toBeVisible({ timeout: 20_000 })
  await err.hover()
  await expect(text('spell-tooltip')).toBeVisible()
  await page.locator('[data-testid="spell-suggestion"][data-value="إلى"]').click()
  await expect.poll(docText).toBe('ذهبت إلى المدرسة')
  await expect(page.locator('.cm-spell-error')).toHaveCount(0)
  // the panel lists issues as well
  await setDocText('ذهبت الى المدرسه')
  await text('toggle-spell-panel').click()
  await expect(text('spell-issue').first()).toBeVisible({ timeout: 20_000 })
  await text('right-panel-close').click()
})

test('legal: tafqeet inserts text at the cursor', async () => {
  await setDocText('المبلغ: ')
  await text('toggle-legal-panel').click()
  await text('tafqeet-amount').fill('1500')
  await text('tafqeet-currency').selectOption('EGP')
  await text('tafqeet-run').click()
  await expect(text('tafqeet-result')).toBeVisible()
  const words = (await text('tafqeet-result').innerText()).trim()
  expect(words.length).toBeGreaterThan(5)
  await text('tafqeet-insert').click()
  await expect.poll(docText).toBe('المبلغ: ' + words)
})

test('legal: document check lists a planted amount mismatch and jumps to it', async () => {
  const planted = '1500 (ألف وستمائة جنيه)'
  await setDocText(`يدفع المستأجر مبلغ ${planted} شهرياً.`)
  await text('legal-tab-checks').click()
  await text('legal-check-run').click()
  const issue = page.locator('[data-testid="legal-issue"][data-group="amounts"]').first()
  await expect(issue).toBeVisible()
  await issue.getByTestId('legal-jump').click()
  const sel = await page.evaluate(() => {
    const v = (
      document.querySelector('.cm-content') as unknown as {
        cmView: {
          view: {
            state: {
              selection: { main: { from: number; to: number } }
              sliceDoc(a: number, b: number): string
            }
          }
        }
      }
    ).cmView.view
    const r = v.state.selection.main
    return v.state.sliceDoc(r.from, r.to)
  })
  expect(sel).toBe(planted)
})

test('legal: template renders live and creates a document', async () => {
  await text('legal-tab-templates').click()
  await expect(text('tpl-item').first()).toBeVisible()
  await text('tpl-open').first().click()
  await expect(text('tpl-form')).toBeVisible()
  await expect(text('tpl-sample-notice')).toBeVisible()
  // required fields empty -> per-field errors and creation disabled
  await expect(text('tpl-field-error').first()).toBeVisible()
  await expect(text('tpl-create')).toBeDisabled()
  const vars = page.locator('[data-testid="tpl-form"] [data-var]')
  const n = await vars.count()
  for (let i = 0; i < n; i++) {
    const v = vars.nth(i)
    const party = v.locator('input[data-testid$="-name"]')
    if (await party.count()) {
      await party.fill('أحمد علي')
      continue
    }
    if (await v.locator('select').count()) continue // choice has a default
    const input = v.locator('input').first()
    const type = await input.getAttribute('type')
    const mode = await input.getAttribute('inputmode')
    if (type === 'date') await input.fill('2025-03-14')
    else if (mode === 'decimal') {
      const label = await v.locator('label').innerText()
      await input.fill(/أجرة|مبلغ|تأمين/.test(label) ? '1500' : '5')
    } else await input.fill('القاهرة')
  }
  await expect(text('tpl-create')).toBeEnabled({ timeout: 15_000 })
  await expect(text('tpl-preview')).toContainText('أحمد علي')
  await text('tpl-create').click()
  await expect(text('doc-title')).toHaveText('عقد إيجار سكني')
  await expect.poll(docText).toContain('أحمد علي')
})

test('settings: glossary manager and legal level', async () => {
  await text('right-panel-close').click()
  await text('open-settings').click()
  await text('tab-glossary').click()
  await text('gloss-term').fill('الغبن')
  await text('gloss-avoid').fill('الغبن العادي')
  await text('gloss-save').click()
  await expect(text('gloss-row').filter({ hasText: 'الغبن' }).first()).toBeVisible()
  await text('tab-general').click()
  await expect(
    page.locator('[data-testid="setting-tashkeel-level"] option[value="legal"]')
  ).toHaveCount(1)
  await text('settings-close').click()
})

test('crash recovery: killed sidecar restarts and becomes ready again', async () => {
  const pids = sidecarPids()
  const pid = pids[pids.length - 1]
  expect(pid).toBeGreaterThan(0)
  process.kill(pid, 'SIGKILL')
  await expect(text('status-sidecar')).toContainText('إعادة تشغيل')
  await expect(text('status-sidecar')).toContainText('المحرك: جاهز', { timeout: 60_000 })
  const now = sidecarPids()
  expect(now.length).toBe(pids.length + 1)
  expect(now[now.length - 1]).not.toBe(pid)
  // the UI talks to the new sidecar (new port)
  await text('document-item').first().click()
  await expect(text('doc-title')).not.toHaveText('لم يتم اختيار مستند')
})
