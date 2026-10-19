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
let app: ElectronApplication
let page: Page
let userData: string
let outDir: string

const t = (id: string) => page.getByTestId(id)
const api = <T = unknown>(method: string, path: string, body?: unknown): Promise<T> =>
  page.evaluate(
    async ([m, p, b]) => {
      const cfg = await (
        window as unknown as {
          mizajAPI: { getBackendConfig(): Promise<{ baseUrl: string; token: string }> }
        }
      ).mizajAPI.getBackendConfig()
      const r = await fetch(`${cfg.baseUrl}${p as string}`, {
        method: m as string,
        headers: {
          'X-Mizaj-Token': cfg.token,
          ...(b ? { 'Content-Type': 'application/json' } : {})
        },
        body: b ? JSON.stringify(b) : undefined
      })
      return r.status === 204 ? null : await r.json()
    },
    [method, path, body]
  ) as Promise<T>
const cmState = () =>
  page.evaluate(() => {
    const v = (
      document.querySelector('.cm-content') as unknown as {
        cmView: {
          view: {
            state: {
              doc: { toString(): string; length: number }
              selection: { main: { from: number; to: number; head: number } }
              sliceDoc(a: number, b: number): string
            }
            scrollDOM: HTMLElement
          }
        }
      }
    ).cmView.view
    const s = v.state.selection.main
    return {
      text: v.state.doc.toString(),
      from: s.from,
      to: s.to,
      head: s.head,
      selected: v.state.sliceDoc(s.from, s.to),
      scrollTop: v.scrollDOM.scrollTop
    }
  })

async function launch(extraEnv: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      ...extraEnv
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-ssp-'))
  outDir = mkdtempSync(join(tmpdir(), 'mizaj-e2e-ssp-out-'))
})
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})
test.afterEach(async () => {
  await app?.close().catch(() => {})
})

// ------------------------------------------------------------------ guided tour
test('first-run tour: 5 steps in RTL, next/prev, Esc skips, shown once, replay from Ctrl+K and Help', async () => {
  await launch({ MIZAJ_E2E_TOUR: '1' })
  const card = t('tour-card')
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card).toHaveAttribute('dir', 'rtl')
  await expect(t('tour-progress')).toContainText('الخطوة ١ من ٥')
  await expect(t('tour-prev')).toBeDisabled()
  await expect(t('spotlight-ring')).toBeVisible() // points at the real «ملف» button

  // RTL: «السابق» sits to the right of «التالي»
  // both read in one frame: the card may still be gliding to its spotlight position
  await expect
    .poll(() =>
      page.evaluate(() => {
        const r = (id: string): number =>
          document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().x
        return r('tour-prev') > r('tour-next')
      })
    )
    .toBe(true)

  const order: string[] = []
  for (let i = 0; i < 4; i++) {
    order.push((await card.getAttribute('data-step'))!)
    await t('tour-next').click()
  }
  expect(order).toEqual(['document', 'tashkeel', 'proofread', 'palette'])
  await expect(card).toHaveAttribute('data-step', 'history')
  await expect(t('tour-next')).toHaveText('إنهاء')
  await t('tour-prev').click()
  await expect(card).toHaveAttribute('data-step', 'palette')
  await expect(t('spotlight-ring')).toHaveCount(0) // a key, not a button: no ring

  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await expect(t('spotlight-ring')).toHaveCount(0)
  await expect
    .poll(async () => (await api<Record<string, string>>('GET', '/api/settings')).tour_done)
    .toBe('true')
  await app.close()

  // shown once: not again after a restart, even when the tour is allowed
  await launch({ MIZAJ_E2E_TOUR: '1' })
  await page.waitForTimeout(3000)
  await expect(t('tour-card')).toHaveCount(0)

  // replay from the palette
  await page.keyboard.press('Control+k')
  await t('palette-input').fill('جولة')
  await expect(page.locator('[data-entry="cmd:app.tour"]')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(t('tour-card')).toBeVisible()
  await t('tour-skip').click()
  await expect(t('tour-card')).toHaveCount(0)

  // replay from Settings > Help
  await t('open-settings').click()
  await t('open-tour').click()
  await expect(t('tour-card')).toBeVisible()
  for (let i = 0; i < 5; i++) await t('tour-next').click()
  await expect(t('tour-card')).toHaveCount(0)
})

// ------------------------------------------------------------------ start screen
const LINES = Array.from(
  { length: 140 },
  (_, i) =>
    `الفقرة رقم ${i + 1}: ذهب المُدَرِّسُ إلى المَدْرَسَةِ صباحاً وكتب أحمد الرسالة ثم عاد إلى البيت بعد الظهر.`
)
let docB = 0

test('start screen: recent files with project, relative time and snippet; resumes cursor and scroll; remove from list', async () => {
  await launch()
  await expect(t('start-screen')).toBeVisible() // nothing open: welcome screen
  for (const id of ['start-new', 'start-import', 'start-guide']) await expect(t(id)).toBeVisible()
  await expect(t('start-recent-empty')).toBeVisible()

  const p = await api<{ id: number }>('POST', '/api/projects', { name: 'قضية الإيجار' })
  await api('POST', '/api/documents', {
    project_id: p.id,
    title: 'عقد الإيجار',
    raw_content: LINES.join('\n')
  })
  const b = await api<{ id: number }>('POST', '/api/documents', {
    project_id: p.id,
    title: 'مذكرة الدفاع',
    raw_content: 'نص قصير في المذكرة عن الاستئناف.'
  })
  docB = b.id
  await app.close()
  await launch()

  // open A, put the cursor deep in the text and scroll
  await t('project-item')
    .first()
    .click()
    .catch(() => {})
  await page.locator(`[data-testid="document-item"]`, { hasText: 'عقد الإيجار' }).click()
  await expect(t('doc-title')).toHaveText('عقد الإيجار')
  await expect(t('start-screen')).toHaveCount(0)
  const target = LINES.slice(0, 90).join('\n').length
  await page.evaluate((pos) => {
    const v = (
      document.querySelector('.cm-content') as unknown as {
        cmView: { view: { dispatch(s: unknown): void; scrollDOM: HTMLElement } }
      }
    ).cmView.view
    v.dispatch({ selection: { anchor: pos } })
    v.scrollDOM.scrollTop = 1500
    v.scrollDOM.dispatchEvent(new Event('scroll'))
  }, target)
  await page.waitForTimeout(900) // remembered after a short pause
  // open B too, then close both tabs: the start screen comes back
  await page.locator(`[data-testid="document-item"]`, { hasText: 'مذكرة الدفاع' }).click()
  await expect(t('doc-title')).toHaveText('مذكرة الدفاع')
  await page.keyboard.press('Control+w')
  await page.keyboard.press('Control+w')
  await expect(t('start-screen')).toBeVisible()

  const items = t('start-recent-item')
  await expect(items).toHaveCount(2)
  const first = items.filter({ hasText: 'مذكرة الدفاع' })
  await expect(first.getByTestId('start-recent-project')).toHaveText('قضية الإيجار')
  await expect(first.getByTestId('start-recent-time')).toHaveText(/^(الآن|منذ .+)$/)
  await expect(first.getByTestId('start-recent-snippet')).toContainText('نص قصير في المذكرة')

  // «continue where you stopped»
  await items.filter({ hasText: 'عقد الإيجار' }).getByTestId('start-recent-open').click()
  await expect(t('doc-title')).toHaveText('عقد الإيجار')
  await expect.poll(async () => (await cmState()).head).toBe(target)
  await expect.poll(async () => (await cmState()).scrollTop).toBeGreaterThan(1000)

  // remove an entry: only from the list, the document stays
  await page.keyboard.press('Control+w')
  await expect(t('start-screen')).toBeVisible()
  await items.filter({ hasText: 'مذكرة الدفاع' }).getByTestId('start-recent-remove').click()
  await expect(items).toHaveCount(1)
  expect((await api<{ id: number }[]>('GET', `/api/documents?project_id=${p.id}`)).length).toBe(2)

  // typing in the empty editor dismisses the welcome screen
  await page.locator('.cm-content').click({ position: { x: 4, y: 4 } }) // beside the card: clicks pass through
  await page.keyboard.type('مرحبا')
  await expect(t('start-screen')).toHaveCount(0)
})

// ------------------------------------------------------------------ search across files
test('search across all files: normalized, highlighted, grouped by document, opens at the match; palette group', async () => {
  await launch()
  await page.keyboard.press('Control+Shift+f')
  await expect(t('search-panel')).toBeVisible()
  await t('search-input').fill('مدرسه') // ta marbuta as ha, no marks
  const results = t('search-result')
  await expect(results).toHaveCount(1) // only «عقد الإيجار» mentions it
  await expect(results.first().getByTestId('search-doc')).toContainText('عقد الإيجار')
  const hits = results.first().getByTestId('search-hit')
  await expect(hits.first()).toBeVisible()
  expect(await hits.count()).toBeGreaterThan(1)
  await expect(hits.first().locator('mark').first()).toContainText('المَدْرَسَةِ') // original, marks intact

  await t('search-input').fill('احمد') // أحمد with hamza folded
  await expect(t('search-result')).toHaveCount(1)
  await t('search-input').fill('كلمة غير موجودة')
  await expect(t('search-empty')).toBeVisible()

  await t('search-input').fill('الاستئناف')
  await expect(results).toHaveCount(1)
  await results.first().getByTestId('search-hit').first().click()
  await expect(t('search-panel')).toHaveCount(0)
  await expect(t('doc-title')).toHaveText('مذكرة الدفاع')
  await expect.poll(async () => (await cmState()).selected).toContain('الاستئناف')

  // Ctrl+K: the same hits under «في المحتوى»
  await page.keyboard.press('Control+k')
  await t('palette-input').fill('المدرسة')
  await expect(t('palette-group-content')).toHaveText('في المحتوى')
  const hit = page.locator('[data-entry^="content:"]').first()
  await expect(hit).toBeVisible()
  await hit.click()
  await expect(t('doc-title')).toHaveText('عقد الإيجار')
  await expect
    .poll(async () => (await cmState()).selected.replace(/[\u064B-\u0652]/g, ''))
    .toContain('المدرسة')

  // the index follows edits
  await api('PUT', `/api/documents/${docB}`, { raw_content: 'نص جديد عن التحكيم التجاري' })
  await page.keyboard.press('Control+Shift+f')
  await t('search-input').fill('التحكيم')
  await expect(results).toHaveCount(1)
  await t('search-input').fill('الاستئناف')
  await expect(t('search-empty')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(t('search-panel')).toHaveCount(0)
})

// ------------------------------------------------------------------ printing
function pdfInfo(file: string): { pages: number; text: string } {
  const head = readFileSync(file).subarray(0, 5).toString('latin1')
  expect(head).toBe('%PDF-')
  // the same interpreter that runs the sidecar (CI: MIZAJ_PYTHON=python); pdfminer is a backend dep
  const venv = resolve(desktopDir, '../backend/.venv/bin/python')
  const py = process.env.MIZAJ_PYTHON || (existsSync(venv) ? venv : 'python')
  const out = execFileSync(
    py,
    [
      '-I',
      '-c',
      [
        'import sys, json',
        'from pdfminer.high_level import extract_pages, extract_text',
        'from pdfminer.layout import LTTextContainer',
        'n = sum(1 for _ in extract_pages(sys.argv[1]))',
        'print(json.dumps({"pages": n, "text": extract_text(sys.argv[1])}, ensure_ascii=False))'
      ].join('\n'),
      file
    ],
    { encoding: 'utf8', maxBuffer: 1 << 26 }
  )
  return JSON.parse(out) as { pages: number; text: string }
}
const rawPageCount = (file: string): number =>
  (
    readFileSync(file)
      .toString('latin1')
      .match(/\/Type\s*\/Page(?![s\w])/g) ?? []
  ).length

test('print preview (Ctrl+P) and PDF via printToPDF: page count, header text, Arabic-Indic page numbers, RTL', async () => {
  const pdf = join(outDir, 'out.pdf')
  await launch({ MIZAJ_E2E_SAVE_PATH: pdf })
  await page.locator(`[data-testid="document-item"]`, { hasText: 'عقد الإيجار' }).click()
  await expect(t('doc-title')).toHaveText('عقد الإيجار')

  await page.keyboard.press('Control+p')
  const dlg = t('print-preview')
  await expect(dlg).toBeVisible()
  await expect(dlg).toHaveAttribute('dir', 'rtl')
  await expect(t('print-title')).toHaveValue('عقد الإيجار')
  const sheets = page.locator('.print-sheet')
  await expect(sheets.first()).toBeVisible({ timeout: 30_000 })
  const n = await sheets.count()
  expect(n).toBeGreaterThan(2)
  await expect(t('print-pages')).toContainText('صفحة')
  // header on every page; footer «صفحة ١ من N» in Arabic-Indic digits
  const toIndic = (x: number) => String(x).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])
  await expect(page.locator('.print-title')).toHaveCount(n)
  await expect(sheets.first().locator('.print-title')).toHaveText('عقد الإيجار')
  await expect(sheets.first().locator('.print-foot')).toHaveText(`صفحة ١ من ${toIndic(n)}`)
  await expect(sheets.last().locator('.print-foot')).toHaveText(
    `صفحة ${toIndic(n)} من ${toIndic(n)}`
  )
  await expect(sheets.first()).toHaveAttribute('dir', 'rtl')

  // optional case data in the header
  await t('print-case-toggle').check()
  await t('print-case-number').fill('123/2026')
  await t('print-case-court').fill('محكمة القاهرة')
  await expect(sheets.first().locator('.print-case')).toContainText(
    'رقم القضية: 123/2026 · المحكمة: محكمة القاهرة'
  )
  await expect.poll(() => sheets.count()).toBe(n)

  // «حفظ PDF» goes through webContents.printToPDF
  await t('print-pdf').click()
  await expect(dlg).toHaveCount(0, { timeout: 60_000 })
  expect(existsSync(pdf)).toBe(true)
  expect(rawPageCount(pdf)).toBe(n)
  const info = pdfInfo(pdf)
  expect(info.pages).toBe(n)
  // header text: pdf text comes back in visual order with presentation forms, so normalize
  // (NFKC) and accept either direction
  const compact = info.text.normalize('NFKC').replace(/\s+/g, '')
  for (const w of ['عقد', 'محكمة', 'القاهرة', 'القضية']) {
    const rev = [...w].reverse().join('')
    expect(compact.includes(w) || compact.includes(rev), `PDF text has «${w}»`).toBe(true)
  }
  // Arabic-Indic page numbers made it into the PDF text
  expect(info.text).toMatch(/[٠-٩]/)
})
