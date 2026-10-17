import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** Electron hardening (8.2) + per-launch API token (8.1.1) against the real app. */

const desktopDir = resolve(__dirname, '../..')
let app: ElectronApplication
let page: Page
let userData: string

interface Cfg {
  baseUrl: string
  token: string
}
const cfg = (): Promise<Cfg> =>
  page.evaluate(() =>
    (
      window as unknown as { mizajAPI: { getBackendConfig(): Promise<Cfg> } }
    ).mizajAPI.getBackendConfig()
  )

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-sec-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_E2E_EXPOSE_TOKEN: '1'
    }
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('window is sandboxed with isolation and no node integration', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const p = (
      BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences(): Record<string, unknown>
      }
    ).getLastWebPreferences()
    return {
      contextIsolation: p.contextIsolation,
      sandbox: p.sandbox,
      nodeIntegration: p.nodeIntegration,
      webSecurity: p.webSecurity,
      allowRunningInsecureContent: p.allowRunningInsecureContent,
      spellChecker: BrowserWindow.getAllWindows()[0].webContents.session.isSpellCheckerEnabled(),
      webviewTag: p.webviewTag
    }
  })
  expect(prefs).toMatchObject({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellChecker: false,
    webviewTag: false
  })
  // the renderer has no Node
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
    'undefined'
  )
  expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe(
    'undefined'
  )
})

test('CSP: inline script blocked, no unsafe-eval in the policy', async () => {
  const r = await page.evaluate(async () => {
    let inlineRan = false
    const violated = new Promise<boolean>((res) => {
      document.addEventListener('securitypolicyviolation', () => res(true), { once: true })
      setTimeout(() => res(false), 1500)
    })
    const s = document.createElement('script')
    s.textContent = 'window.__inline = 1'
    document.head.appendChild(s)
    inlineRan = (window as unknown as { __inline?: number }).__inline === 1
    return { inlineRan, violated: await violated }
  })
  expect(r).toEqual({ inlineRan: false, violated: true })
  const meta = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  expect(meta).toContain("script-src 'self'")
  expect(meta).toContain("object-src 'none'")
  expect(meta).not.toContain('unsafe-eval')
})

test('navigation, popups and permissions are denied', async () => {
  const before = page.url()
  const popup = await page.evaluate(() => window.open('https://example.com/') === null)
  expect(popup).toBe(true)
  expect(app.windows()).toHaveLength(1)
  await page.evaluate(() => {
    location.href = 'https://example.com/'
  })
  await page.waitForTimeout(500)
  expect(page.url()).toBe(before)
  const perms = await page.evaluate(async () => {
    const out: Record<string, string> = {}
    out.notification = await Notification.requestPermission()
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
      out.mic = 'granted'
    } catch (e) {
      out.mic = (e as Error).name
    }
    out.geo = await new Promise((res) =>
      navigator.geolocation.getCurrentPosition(
        () => res('granted'),
        (e) => res(`denied:${e.code}`)
      )
    )
    return out
  })
  expect(perms.notification).not.toBe('granted')
  expect(perms.mic).not.toBe('granted')
  expect(perms.geo).toMatch(/^denied/)
})

test('backend requires the token; the token never reaches logs or argv', async () => {
  const c = await cfg()
  expect(c.token).toMatch(/^[0-9a-f]{64}$/)
  expect(await app.evaluate(() => process.env.MIZAJ_API_TOKEN)).toBe(c.token)
  // Node-side fetch from the main process (no CORS in the way)
  const call = (headers: Record<string, string>) =>
    app.evaluate(
      async (_, [url, h]) =>
        (await fetch(url as string, { headers: h as Record<string, string> })).status,
      [`${c.baseUrl}/api/settings`, headers] as const
    )
  expect(await call({})).toBe(401)
  expect(await call({ 'X-Mizaj-Token': 'wrong' + c.token.slice(5) })).toBe(401)
  expect(await call({ 'X-Mizaj-Token': c.token })).toBe(200)
  // /health stays public and brief
  expect(await app.evaluate(async (_, u) => (await fetch(u)).status, `${c.baseUrl}/health`)).toBe(
    200
  )

  const logs = join(userData, 'logs')
  for (const f of readdirSync(logs))
    expect(readFileSync(join(logs, f), 'utf8')).not.toContain(c.token)
  // not on any process command line (argv is visible to every local user)
  for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      expect(readFileSync(`/proc/${pid}/cmdline`, 'latin1')).not.toContain(c.token)
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT' && (e as { code?: string }).code !== 'EACCES')
        throw e
    }
  }
})

test('IPC: external links are https + allowlisted; paths must come from a dialog', async () => {
  const call = <T>(fn: string, arg: unknown) =>
    page.evaluate(
      ([f, a]) =>
        (
          window as unknown as {
            mizajAPI: Record<string, (x: unknown) => Promise<unknown>>
          }
        ).mizajAPI[f as string](a),
      [fn, arg]
    ) as Promise<T>
  expect(await call('openExternal', 'https://tanzil.net/download/')).toBe(true)
  for (const bad of [
    'http://tanzil.net',
    'https://evil.example/',
    'file:///etc/passwd',
    'javascript:1',
    42,
    null
  ])
    expect(await call('openExternal', bad)).toBe(false)
  expect(await call('openPath', '/etc/passwd')).toBe('path not allowed')
  expect(await call('openPath', 12345)).toBe('invalid path')
  expect(await call('openPath', 'x'.repeat(5000))).toBe('invalid path')
  const shell = await app.evaluate(
    () =>
      (globalThis as unknown as { __mizajShellLog: { kind: string; target: string }[] })
        .__mizajShellLog
  )
  expect(shell).toEqual([{ kind: 'external', target: 'https://tanzil.net/download/' }])
  const log = readFileSync(join(userData, 'logs', 'mizaj-main.log'), 'utf8')
  expect(log).toContain('openExternal rejected')
})

test('reloading the window does not trigger a 401 toast', async () => {
  const unauthorized: number[] = []
  page.on('response', (r) => {
    if (r.status() === 401) unauthorized.push(r.status())
  })
  for (let i = 0; i < 3; i++) {
    await page.reload()
    await expect(page.getByTestId('status-sidecar')).toContainText('المحرك: جاهز')
  }
  await page.waitForTimeout(1000)
  await expect(page.getByTestId('toasts').getByText('غير مصرّح')).toHaveCount(0)
  expect(unauthorized).toEqual([])
})
