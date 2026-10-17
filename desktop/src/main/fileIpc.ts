import { app, BrowserWindow, dialog, shell } from 'electron'
import { handleSecure } from './ipcGuard'
import {
  isAllowedExternalUrl,
  isBoundedString,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  PathAllowlist
} from './security'

/** Paths returned by native dialogs (or the documented E2E stubs); only these may be opened. */
export const dialogPaths = Object.assign(new PathAllowlist(), {
  addAndReturn<T extends string | null>(p: T): T {
    if (p) dialogPaths.add(p)
    return p
  }
})
let logWarn: (...a: unknown[]) => void = () => {}
export function setFileIpcLogger(l: (...a: unknown[]) => void): void {
  logWarn = l
}

/** Characters Windows forbids in file names. */
export function sanitizeFileName(name: unknown, fallback = 'mizaj'): string {
  const s =
    typeof name === 'string'
      ? name
          .slice(0, MAX_NAME_LENGTH)
          .replace(/[\\/:*?"<>|\0]/g, '_')
          .trim()
      : ''
  return s || fallback
}

/** Only allowlisted https:// links (no credentials) may be handed to the system browser. */
export const isSafeExternalUrl = isAllowedExternalUrl

export function cleanExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, 20)
    .filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9]{1,10}$/.test(x))
    .map((x) => x.toLowerCase())
}

export interface FileDialogOpts {
  defaultName?: string
  extensions?: string[]
  filterName?: string
}

/** Test hook: when MIZAJ_E2E_NO_SHELL is set, shell actions are recorded instead of executed. */
export const shellLog: { kind: string; target: string }[] = []
;(globalThis as unknown as { __mizajShellLog: typeof shellLog }).__mizajShellLog = shellLog

export function registerFileIpc(): void {
  const winOf = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  handleSecure('dialog:save-file', async (e, raw: unknown) => {
    if (process.env.MIZAJ_E2E_SAVE_PATH)
      return dialogPaths.addAndReturn(process.env.MIZAJ_E2E_SAVE_PATH) // test stub
    const o = (raw && typeof raw === 'object' ? raw : {}) as FileDialogOpts
    const exts = cleanExtensions(o.extensions)
    const opts = {
      defaultPath: sanitizeFileName(o.defaultName),
      filters: exts.length
        ? [{ name: isBoundedString(o.filterName, 64) ? o.filterName : exts[0], extensions: exts }]
        : []
    }
    const w = winOf(e)
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const ext = exts[0]
    return dialogPaths.addAndReturn(
      !ext || exts.some((x) => r.filePath.toLowerCase().endsWith(`.${x}`))
        ? r.filePath
        : `${r.filePath}.${ext}`
    )
  })

  handleSecure('dialog:open-file', async (e, raw: unknown) => {
    if (process.env.MIZAJ_E2E_OPEN_PATH)
      return dialogPaths.addAndReturn(process.env.MIZAJ_E2E_OPEN_PATH) // test stub
    const o = (raw && typeof raw === 'object' ? raw : {}) as FileDialogOpts
    const exts = cleanExtensions(o.extensions)
    const opts = {
      properties: ['openFile' as const],
      filters: exts.length
        ? [{ name: isBoundedString(o.filterName, 64) ? o.filterName : exts[0], extensions: exts }]
        : []
    }
    const w = winOf(e)
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : dialogPaths.addAndReturn(r.filePaths[0])
  })

  handleSecure('dialog:open-directory', async (e, title: unknown) => {
    if (process.env.MIZAJ_E2E_DIR_PATH)
      return dialogPaths.addAndReturn(process.env.MIZAJ_E2E_DIR_PATH) // test stub
    const opts = {
      title: isBoundedString(title, MAX_NAME_LENGTH) ? title : undefined,
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const w = winOf(e)
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : dialogPaths.addAndReturn(r.filePaths[0])
  })

  handleSecure('shell:open-path', async (_e, p: unknown) => {
    if (!isBoundedString(p, MAX_PATH_LENGTH) || !p) return 'invalid path'
    if (!dialogPaths.has(p)) {
      logWarn('security: shell:open-path rejected (path was not chosen in a dialog)')
      return 'path not allowed'
    }
    if (process.env.MIZAJ_E2E_NO_SHELL) {
      shellLog.push({ kind: 'path', target: p })
      return ''
    }
    return shell.openPath(p) // '' on success, else an error message
  })

  handleSecure('shell:open-external', async (_e, url: unknown) => {
    if (!isSafeExternalUrl(url)) {
      logWarn('security: openExternal rejected', rejectedHost(url))
      return false
    }
    if (process.env.MIZAJ_E2E_NO_SHELL) {
      shellLog.push({ kind: 'external', target: String(url) })
      return true
    }
    await shell.openExternal(String(url))
    return true
  })

  handleSecure('app:relaunch', () => {
    if (process.env.MIZAJ_E2E_NO_SHELL) {
      shellLog.push({ kind: 'relaunch', target: '' })
      return
    }
    app.relaunch()
    app.quit()
  })
}

function rejectedHost(url: unknown): string {
  try {
    return typeof url === 'string' ? new URL(url).host.slice(0, 100) : typeof url
  } catch {
    return '<invalid url>'
  }
}
