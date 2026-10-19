import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import { handleSecure } from '../ipcGuard'
import { createBackendDeps, type BackendTarget } from '../systemwide/backend'
import type { Exec } from './install'
import { MockWindows } from './mockWindows'
import { WordAddinService, type SecretBox } from './service'

/**
 * Electron wiring of the Word add-in: the settings page IPC and the lifecycle of the HTTPS server.
 * Off by default: nothing listens and nothing is written until the user enables it in
 * Settings > Advanced > «إضافة Word». The logic is in the Electron-free modules next to this file.
 *
 * Test hooks (unpackaged builds only): MIZAJ_E2E_WORDADDIN_MOCK=1 replaces reg.exe / certutil.exe
 * with an in-memory fake and the OS key encryption with a reversible one; MIZAJ_E2E_WORDADDIN_PORT
 * picks the port.
 */

export const CH = {
  getState: 'wordaddin:get-state',
  setEnabled: 'wordaddin:set-enabled',
  install: 'wordaddin:install',
  uninstall: 'wordaddin:uninstall',
  test: 'wordaddin:test',
  openCatalog: 'wordaddin:open-catalog'
} as const

export interface WordAddinDeps {
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void }
  getBackend: () => BackendTarget
}

const realExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 180_000, encoding: 'utf8', maxBuffer: 1 << 20 },
      (err, stdout) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0
        resolve({ code, stdout: String(stdout ?? '') })
      }
    )
  })

function secretBox(mock: boolean): SecretBox {
  if (mock)
    return {
      encrypt: (s) => Buffer.from(`E2E:${Buffer.from(s).toString('base64')}`),
      decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
    }
  return {
    encrypt: (s) => {
      if (!safeStorage.isEncryptionAvailable()) return null
      const backend = (
        safeStorage as { getSelectedStorageBackend?: () => string }
      ).getSelectedStorageBackend?.()
      if (backend === 'basic_text') return null // not real protection
      return safeStorage.encryptString(s)
    },
    decrypt: (b) => {
      try {
        return safeStorage.decryptString(b)
      } catch {
        return null
      }
    }
  }
}

/** Office's per-user add-in cache; stale manifests live here (best effort, Word may hold the files). */
function clearWefCache(): void {
  const base = process.env.LOCALAPPDATA
  if (!base) return
  const wef = join(base, 'Microsoft', 'Office', '16.0', 'Wef')
  if (!existsSync(wef)) return
  for (const n of readdirSync(wef)) rmSync(join(wef, n), { recursive: true, force: true })
}

export function registerWordAddin(deps: WordAddinDeps): { dispose(): Promise<void> } {
  const mock = !app.isPackaged && process.env.MIZAJ_E2E_WORDADDIN_MOCK === '1'
  const supported = process.platform === 'win32' || mock
  const dir = join(app.getPath('userData'), 'wordaddin')
  const backend = createBackendDeps(deps.getBackend)
  const win = mock ? new MockWindows() : null
  const mockPort = Number(process.env.MIZAJ_E2E_WORDADDIN_PORT)

  const service = new WordAddinService({
    dir,
    rootDir: join(app.getAppPath(), 'out', 'word-addin'),
    exec: win ? win.exec : realExec,
    secrets: secretBox(mock),
    pipeline: backend,
    engineReady: () => deps.getBackend().baseUrl !== null,
    supported,
    port: mock && Number.isInteger(mockPort) && mockPort > 1023 ? mockPort : undefined,
    log: (e) => deps.log.info(e), // event codes only, never text or URLs
    clearWefCache: mock ? undefined : clearWefCache,
    vendorDir: () => {
      const v = join(dir, 'vendor')
      return existsSync(join(v, 'office.js')) ? v : null
    }
  })

  handleSecure(CH.getState, () => service.getState())
  handleSecure(CH.setEnabled, (_e, v: unknown) => service.setEnabled(v === true))
  handleSecure(CH.install, () => service.install())
  handleSecure(CH.uninstall, () => service.uninstall())
  handleSecure(CH.test, () => service.test())
  handleSecure(CH.openCatalog, async () => {
    mkdirSync(service.catalogDir, { recursive: true })
    return shell.openPath(service.catalogDir)
  })

  if (mock && win) {
    ;(globalThis as Record<string, unknown>).__mizajWordAddin = {
      win,
      service,
      port: () => service.getState().then((s) => s.port)
    }
  }

  void app.whenReady().then(async () => {
    await service.start()
    deps.log.info('wordaddin: ready')
  })
  const dispose = (): Promise<void> => service.dispose()
  app.on('will-quit', () => void dispose())
  return { dispose }
}
