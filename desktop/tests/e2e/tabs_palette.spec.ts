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
const docText = () =>
  page.evaluate(() =>
    (
      document.querySelector('.cm-content') as unknown as {
        cmView: { view: { state: { doc: { toString(): string } } } }
      }
    ).cmView.view.state.doc.toString()
  )
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

async function launch(): Promise<void> {
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
}

async function typeInEditor(text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.type(text)
}
const tabTitles = () => t('tab-title').allTextContents()

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-tabs-'))
  await launch()
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('Ctrl+K finds a document by normalised Arabic and Enter opens it', async () => {
  // created through the backend API, so the sidebar does not know it yet
  const p = await api<{ id: number }>('POST', '/api/projects', { name: 'مشروع البحث' })
  await api('POST', '/api/documents', {
    project_id: p.id,
    title: 'مقدّمة الأطروحة',
    raw_content: 'نص المقدمة'
  })
  await api('POST', '/api/documents', {
    project_id: p.id,
    title: 'الخاتمة',
    raw_content: 'نص الخاتمة'
  })

  await page.keyboard.press('Control+k')
  await expect(t('palette')).toBeVisible()
  await expect(t('palette-input')).toBeFocused()
  // overview: commands are listed with their shortcuts
  await expect(t('palette-group-command')).toBeVisible()
  await expect(t('palette-list')).toContainText('Ctrl+T')

  await t('palette-input').fill('مقدمه الاطروحه') // no diacritics, ه for ة, ا for أ
  await expect(t('palette-group-document')).toBeVisible()
  await expect(t('palette-item').first()).toContainText('مقدّمة الأطروحة')
  await page.keyboard.press('Enter')
  await expect(t('palette')).toBeHidden()
  await expect(t('doc-title')).toHaveText('مقدّمة الأطروحة')
  await expect.poll(docText).toBe('نص المقدمة')
  await expect(t('tab')).toHaveCount(1)
})

test('Ctrl+Shift+P opens the palette, finds commands and settings, Esc closes', async () => {
  await page.keyboard.press('Control+Shift+P')
  await expect(t('palette')).toBeVisible()
  await t('palette-input').fill('القران')
  await expect(t('palette-group-settings')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(t('palette')).toBeHidden()

  await page.keyboard.press('Control+k')
  await t('palette-input').fill('اختصارات')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(t('shortcuts-dialog')).toBeVisible()
  await t('shortcuts-close').click()

  await page.keyboard.press('Control+k')
  await t('palette-input').fill('zzzzqqqq')
  await expect(t('palette-empty')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('two tabs keep their own text, switch with Ctrl+Tab / Ctrl+Shift+Tab', async () => {
  // second document opens in its own tab
  await page.keyboard.press('Control+k')
  await t('palette-input').fill('الخاتمه')
  await page.keyboard.press('Enter')
  await expect(t('doc-title')).toHaveText('الخاتمة')
  await expect(t('tab')).toHaveCount(2)
  await expect(t('tab').nth(1)).toHaveAttribute('data-active', 'true')

  await typeInEditor(' + تعديل ب')
  await expect(t('tab-dirty')).toHaveCount(1) // modified dot while unsaved
  await expect.poll(docText).toBe('نص الخاتمة + تعديل ب')

  await page.keyboard.press('Control+Tab') // wraps to the first tab
  await expect(t('doc-title')).toHaveText('مقدّمة الأطروحة')
  await expect.poll(docText).toBe('نص المقدمة')
  await expect(t('tab-dirty')).toHaveCount(0) // saved on leaving the tab

  await typeInEditor(' + تعديل أ')
  await page.keyboard.press('Control+Shift+Tab')
  await expect(t('doc-title')).toHaveText('الخاتمة')
  await expect.poll(docText).toBe('نص الخاتمة + تعديل ب')

  await page.keyboard.press('Control+Shift+Tab')
  await expect(t('doc-title')).toHaveText('مقدّمة الأطروحة')
  await expect.poll(docText).toBe('نص المقدمة + تعديل أ')

  // each tab has its own undo history: undo only reverts this tab's edit
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+z')
  await expect.poll(docText).toBe('نص المقدمة')
  await page.keyboard.press('Control+Tab')
  await expect.poll(docText).toBe('نص الخاتمة + تعديل ب')

  // clicking a tab activates it too
  await t('tab').first().click()
  await expect(t('doc-title')).toHaveText('مقدّمة الأطروحة')
  expect(await tabTitles()).toEqual(['مقدّمة الأطروحة', 'الخاتمة'])
})

test('Ctrl+T opens an empty tab that a palette-opened document fills', async () => {
  const p = (await api<{ id: number }[]>('GET', '/api/projects'))[0]
  await api('POST', '/api/documents', { project_id: p.id, title: 'ملحق', raw_content: 'نص الملحق' })
  await page.keyboard.press('Control+t')
  await expect(t('tab')).toHaveCount(3)
  await expect(t('doc-title')).toHaveText('لم يتم اختيار مستند')
  await expect(t('export-docx')).toBeDisabled() // per-document actions need a document in the active tab
  await page.keyboard.press('Control+k')
  await t('palette-input').fill('ملحق')
  await expect(t('palette-item').first()).toContainText('ملحق')
  await page.keyboard.press('Enter')
  await expect(t('doc-title')).toHaveText('ملحق')
  await expect(t('tab')).toHaveCount(3)
  await expect(t('export-docx')).toBeEnabled()
  await expect.poll(docText).toBe('نص الملحق')
})

test('closing tabs: middle click, Ctrl+W, and the unsaved-changes prompt', async () => {
  // middle click closes a tab
  await t('tab').last().click({ button: 'middle' })
  await expect(t('tab')).toHaveCount(2)

  // a failing save keeps the work unsaved, so closing asks first
  await page.evaluate(() => {
    const w = window as unknown as { __fetch?: typeof fetch }
    w.__fetch = window.fetch
    window.fetch = (input, init) =>
      init?.method === 'PUT' && String(input).includes('/api/documents/')
        ? Promise.reject(new TypeError('offline'))
        : (w.__fetch as typeof fetch)(input, init)
  })
  await typeInEditor('!')
  await page.keyboard.press('Control+w')
  await expect(t('tab-close-dialog')).toBeVisible()
  await page.keyboard.press('Escape') // Esc = cancel
  await expect(t('tab-close-dialog')).toBeHidden()
  await expect(t('tab')).toHaveCount(2)

  await page.keyboard.press('Control+w')
  await t('tab-close-discard').click()
  await expect(t('tab-close-dialog')).toBeHidden()
  await expect(t('tab')).toHaveCount(1)
  await page.evaluate(() => {
    const w = window as unknown as { __fetch?: typeof fetch }
    if (w.__fetch) window.fetch = w.__fetch
  })
})

test('open tabs are restored after a restart', async () => {
  await page.keyboard.press('Control+k')
  await t('palette-input').fill('الخاتمه')
  await page.keyboard.press('Enter')
  await expect(t('doc-title')).toHaveText('الخاتمة')
  const titles = await tabTitles()
  expect(titles.length).toBeGreaterThanOrEqual(2)
  await app.close()
  await launch()
  await expect(t('doc-title')).toHaveText('الخاتمة')
  await expect.poll(tabTitles).toEqual(titles)
  await expect(t('tab').filter({ hasText: 'الخاتمة' })).toHaveAttribute('data-active', 'true')
})
