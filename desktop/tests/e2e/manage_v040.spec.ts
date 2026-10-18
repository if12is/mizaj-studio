import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
let app: ElectronApplication
let page: Page
let userData: string
let fakeOllama: Server

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

async function newProject(name: string): Promise<void> {
  await t('new-project').click()
  await t('new-project-input').fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('project-name').filter({ hasText: name })).toBeVisible()
}
async function newDocument(projectName: string, title: string): Promise<void> {
  await page
    .getByTestId('project-item')
    .filter({ hasText: projectName })
    .getByTestId('new-document')
    .click()
  await t('new-document-input').fill(title)
  await page.keyboard.press('Enter')
  await expect(t('doc-title')).toHaveText(title)
}
const projectRow = (name: string) => page.getByTestId('project-item').filter({ hasText: name })

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-manage-'))
  fakeOllama = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(
      req.url?.startsWith('/api/tags')
        ? JSON.stringify({ models: [{ name: 'llama3:8b' }, { name: 'qwen2.5:7b' }] })
        : '{}'
    )
  })
  await new Promise<void>((ok) => fakeOllama.listen(0, '127.0.0.1', ok))
  const port = (fakeOllama.address() as AddressInfo).port
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_OLLAMA_URL: `http://127.0.0.1:${port}`
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  await app?.close()
  fakeOllama?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('rename a project and a document from the sidebar', async () => {
  await newProject('مشروع أول')
  await newDocument('مشروع أول', 'مستند قديم')

  await projectRow('مشروع أول').getByTestId('project-rename').click()
  await t('rename-input').fill('مشروع معاد تسميته')
  await page.keyboard.press('Enter')
  await expect(projectRow('مشروع معاد تسميته')).toBeVisible()
  expect((await api<{ name: string }[]>('GET', '/api/projects')).map((p) => p.name)).toContain(
    'مشروع معاد تسميته'
  )

  await t('document-rename').click()
  await t('rename-input').fill('مستند جديد الاسم')
  await page.keyboard.press('Enter')
  await expect(t('document-item')).toHaveText('مستند جديد الاسم')
  await expect(t('doc-title')).toHaveText('مستند جديد الاسم') // the open document follows
  const docs = await api<{ title: string }[]>('GET', '/api/documents?project_id=1')
  expect(docs.map((d) => d.title)).toEqual(['مستند جديد الاسم'])

  // Escape cancels without changing anything
  await t('document-rename').click()
  await t('rename-input').fill('لن يحفظ')
  await page.keyboard.press('Escape')
  await expect(t('document-item')).toHaveText('مستند جديد الاسم')
})

test('delete asks for confirmation in an opaque dialog; cancel keeps everything', async () => {
  await t('document-delete').click()
  await expect(t('confirm-dialog')).toBeVisible()
  await expect(t('confirm-message')).toContainText('مستند جديد الاسم')
  const bg = await t('confirm-dialog').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).toMatch(/^rgb\(/) // no alpha channel: fully opaque panel
  await t('confirm-cancel').click()
  await expect(t('confirm-dialog')).toHaveCount(0)
  await expect(t('document-item')).toHaveCount(1)
  await t('document-delete').click()
  await page.keyboard.press('Escape')
  await expect(t('confirm-dialog')).toHaveCount(0)
  await expect(t('document-item')).toHaveCount(1)
})

test('deleting the open document clears the editor; deleting a project removes its documents', async () => {
  await t('document-delete').click()
  await t('confirm-ok').click()
  await expect(t('document-item')).toHaveCount(0)
  await expect(t('doc-title')).toHaveText('لم يتم اختيار مستند')
  expect(await api<unknown[]>('GET', '/api/documents?project_id=1')).toEqual([])

  await newDocument('مشروع معاد تسميته', 'مستند داخل المشروع')
  await projectRow('مشروع معاد تسميته').getByTestId('project-delete').click()
  await expect(t('confirm-message')).toContainText('مشروع معاد تسميته')
  await t('confirm-ok').click()
  await expect(projectRow('مشروع معاد تسميته')).toHaveCount(0)
  await expect(t('doc-title')).toHaveText('لم يتم اختيار مستند')
  expect(await api<unknown[]>('GET', '/api/projects')).toEqual([])
})

test('Ollama model dropdown lists detected models and saves ollama_model', async () => {
  await t('open-settings').click()
  await t('tab-online').click()
  await expect(t('ollama-model-row')).toHaveCount(0) // only when Ollama is enabled
  await t('switch-online-ollama').check()
  const select = t('ollama-model-select')
  await expect(select).toBeVisible()
  await expect(select.locator('option')).toHaveText(['llama3:8b', 'qwen2.5:7b'])
  await expect(select).toHaveValue('llama3:8b')
  await select.selectOption('qwen2.5:7b')
  await expect
    .poll(async () => (await api<Record<string, string>>('GET', '/api/settings')).ollama_model)
    .toBe('qwen2.5:7b')
  await t('settings-close').click()
  await t('open-settings').click()
  await t('tab-online').click()
  await expect(t('ollama-model-select')).toHaveValue('qwen2.5:7b')
})
