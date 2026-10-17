import { app, BrowserWindow, dialog } from 'electron'
import { handleSecure } from './ipcGuard'
import { TOKEN_HEADER } from './security'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { freemem, homedir, release, totalmem, userInfo } from 'node:os'
import { join } from 'node:path'
import { buildBundle, buildCrashReport, writeCrashReport, type VersionInfo } from './diagnostics'
import { STATUS_EVENT, type PythonProcessManager, type SidecarStatus } from './pythonManager'

interface Deps {
  manager: PythonProcessManager
  log: { error(...a: unknown[]): void; info(...a: unknown[]): void }
  portable: boolean
  apiToken: string
}

function homes(): string[] {
  const h = [homedir()]
  try {
    h.push(userInfo().username)
  } catch {
    /* no user info */
  }
  return h
}

export function versionInfo(portable: boolean): VersionInfo {
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    totalMemMB: Math.round(totalmem() / 1048576),
    freeMemMB: Math.round(freemem() / 1048576),
    packaged: app.isPackaged,
    portable
  }
}

async function getJson(port: number | null, path: string, token: string): Promise<unknown> {
  if (!port) return null
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(3000),
      headers: { [TOKEN_HEADER]: token }
    })
    return await r.json()
  } catch {
    return null
  }
}

function licensesPath(): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'THIRD_PARTY_LICENSES.txt'),
    join(app.getAppPath(), 'build', 'THIRD_PARTY_LICENSES.txt')
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export function registerDiagnostics({ manager, log, portable, apiToken }: Deps): void {
  const crashDir = (): string => join(app.getPath('userData'), 'crash')
  const report = (
    kind: string,
    err: unknown,
    ctx?: Record<string, string | number | boolean | null>
  ): void => {
    try {
      writeCrashReport(crashDir(), buildCrashReport(kind, err, versionInfo(portable), homes(), ctx))
    } catch {
      /* never fail while failing */
    }
  }

  // Crash capture to a local file only (no network, no document text).
  process.on('uncaughtException', (e) => {
    log.error('uncaughtException', e)
    report('uncaughtException', e)
  })
  process.on('unhandledRejection', (e) => {
    log.error('unhandledRejection', e)
    report('unhandledRejection', e)
  })
  app.on('render-process-gone', (_e, _wc, d) => {
    log.error('render-process-gone', d.reason)
    report('render-process-gone', new Error(`renderer gone: ${d.reason}`), { exitCode: d.exitCode })
  })
  app.on('child-process-gone', (_e, d) => {
    log.error('child-process-gone', d.type, d.reason)
    report('child-process-gone', new Error(`${d.type} gone: ${d.reason}`), { exitCode: d.exitCode })
  })
  let lastState = ''
  manager.on(STATUS_EVENT, (s: SidecarStatus) => {
    if (s.state === lastState) return
    lastState = s.state
    if (s.state === 'crashed' || s.state === 'restarting')
      report('sidecar-' + s.state, new Error(s.message ?? `sidecar ${s.state}`), { retry: s.retry })
  })

  handleSecure('diagnostics:export', async (e) => {
    const port = manager.getStatus().port
    const [health, settings] = await Promise.all([
      getJson(port, '/health', apiToken),
      getJson(port, '/api/settings', apiToken)
    ])
    const zip = buildBundle({
      userData: app.getPath('userData'),
      versions: versionInfo(portable),
      health,
      settings: (settings as Record<string, string> | null) ?? null,
      homes: homes()
    })
    let target: string | null = process.env.MIZAJ_E2E_DIAG_PATH ?? null
    if (!target) {
      const w = BrowserWindow.fromWebContents(e.sender)
      const opts = {
        defaultPath: `mizaj-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      }
      const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
      target = r.canceled || !r.filePath ? null : r.filePath
    }
    if (!target) return null
    writeFileSync(target, zip)
    return target
  })

  handleSecure('about:info', () => {
    const p = licensesPath()
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      license: 'GPL-3.0-or-later',
      portable,
      licenses: p ? readFileSync(p, 'utf8') : null
    }
  })
}
