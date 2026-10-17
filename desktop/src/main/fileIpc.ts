import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'

/** Characters Windows forbids in file names. */
export function sanitizeFileName(name: unknown, fallback = 'mizaj'): string {
  const s = typeof name === 'string' ? name.replace(/[\\/:*?"<>|\0]/g, '_').trim() : ''
  return s || fallback
}

/** Only plain https:// links (no credentials) may be handed to the system browser. */
export function isSafeExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname
  } catch {
    return false
  }
}

export function cleanExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
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

  ipcMain.handle('dialog:save-file', async (e, raw: unknown) => {
    if (process.env.MIZAJ_E2E_SAVE_PATH) return process.env.MIZAJ_E2E_SAVE_PATH // test stub
    const o = (raw ?? {}) as FileDialogOpts
    const exts = cleanExtensions(o.extensions)
    const opts = {
      defaultPath: sanitizeFileName(o.defaultName),
      filters: exts.length
        ? [{ name: typeof o.filterName === 'string' ? o.filterName : exts[0], extensions: exts }]
        : []
    }
    const w = winOf(e)
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const ext = exts[0]
    return !ext || exts.some((x) => r.filePath.toLowerCase().endsWith(`.${x}`))
      ? r.filePath
      : `${r.filePath}.${ext}`
  })

  ipcMain.handle('dialog:open-file', async (e, raw: unknown) => {
    if (process.env.MIZAJ_E2E_OPEN_PATH) return process.env.MIZAJ_E2E_OPEN_PATH // test stub
    const o = (raw ?? {}) as FileDialogOpts
    const exts = cleanExtensions(o.extensions)
    const opts = {
      properties: ['openFile' as const],
      filters: exts.length
        ? [{ name: typeof o.filterName === 'string' ? o.filterName : exts[0], extensions: exts }]
        : []
    }
    const w = winOf(e)
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:open-directory', async (e, title: unknown) => {
    if (process.env.MIZAJ_E2E_DIR_PATH) return process.env.MIZAJ_E2E_DIR_PATH // test stub
    const opts = {
      title: typeof title === 'string' ? title : undefined,
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const w = winOf(e)
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle('shell:open-path', async (_e, p: unknown) => {
    if (typeof p !== 'string' || !p) return 'invalid path'
    if (process.env.MIZAJ_E2E_NO_SHELL) {
      shellLog.push({ kind: 'path', target: p })
      return ''
    }
    return shell.openPath(p) // '' on success, else an error message
  })

  ipcMain.handle('shell:open-external', async (_e, url: unknown) => {
    if (!isSafeExternalUrl(url)) return false
    if (process.env.MIZAJ_E2E_NO_SHELL) {
      shellLog.push({ kind: 'external', target: String(url) })
      return true
    }
    await shell.openExternal(String(url))
    return true
  })

  ipcMain.handle('app:relaunch', () => {
    if (process.env.MIZAJ_E2E_NO_SHELL) {
      shellLog.push({ kind: 'relaunch', target: '' })
      return
    }
    app.relaunch()
    app.quit()
  })
}
