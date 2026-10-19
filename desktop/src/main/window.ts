import { BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import type { SidecarStatus } from './pythonManager'
import { registerFileIpc, dialogPaths } from './fileIpc'
import { handleSecure, isTrustedSender } from './ipcGuard'
import { MAX_NAME_LENGTH } from './security'
import { openGuide, safeAnchor } from './guide'
import { parsePrintRequest, printSheets } from './print'

export const FLUSH_TIMEOUT_MS = 2000

let mainWindow: BrowserWindow | null = null
let hideOnClose: () => boolean = () => false
let onMainClosed: () => void = () => {}

/** Called when the main window is really gone (not merely hidden in the tray). */
export function setOnMainClosed(fn: () => void): void {
  onMainClosed = fn
}

/** «تشغيل في الخلفية»: when this returns true the close button hides the window (the tray keeps the app alive). */
export function setHideOnClose(fn: () => boolean): void {
  hideOnClose = fn
}

/** Show the main window (restoring it from the tray), or create it again if it was destroyed. */
export function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else createMainWindow()
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#0F172A',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      webviewTag: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      safeDialogs: true
    }
  })
  win.once('ready-to-show', () => win.show())
  // Navigation / window.open / webview are locked down for all webContents in hardening.ts.
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  attachFlushOnClose(win)
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    onMainClosed()
  })
  return win
}

/** Ask the renderer to flush autosave; resolves on reply or after the timeout. */
export function requestFlush(win: BrowserWindow, timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return resolve()
    const id = win.webContents.id
    const done = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener('app:flush-done', onDone)
      resolve()
    }
    const onDone = (e: Electron.IpcMainEvent): void => {
      if (e.sender.id === id && isTrustedSender(e)) done()
    }
    const timer = setTimeout(done, timeoutMs)
    ipcMain.on('app:flush-done', onDone)
    win.webContents.send('app:flush-request')
  })
}

function attachFlushOnClose(win: BrowserWindow): void {
  let flushed = false
  win.on('close', (e) => {
    if (flushed) return
    e.preventDefault()
    void requestFlush(win).then(() => {
      if (win.isDestroyed()) return
      if (hideOnClose()) {
        win.hide() // background mode: stay in the tray, work is already saved
        return
      }
      flushed = true
      win.close()
    })
  })
}

export function registerIpc(getStatus: () => SidecarStatus, apiToken: string): void {
  registerFileIpc()
  const winOf = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)
  handleSecure('backend:get-config', () => {
    const s = getStatus()
    return {
      port: s.port,
      baseUrl: s.port ? `http://127.0.0.1:${s.port}` : null,
      status: s,
      // The only way the token reaches the renderer (never logged, never in a URL).
      token: apiToken
    }
  })
  // first-run tour: test runs with an isolated profile (MIZAJ_USER_DATA_DIR) do not auto-start it
  handleSecure('app:flags', () => ({
    autoTour: !process.env.MIZAJ_USER_DATA_DIR || process.env.MIZAJ_E2E_TOUR === '1'
  }))
  handleSecure('print:run', async (_e, raw: unknown) => {
    const req = parsePrintRequest(raw)
    if (typeof req === 'string') return { ok: false, error: req }
    return printSheets(req)
  })
  handleSecure('window:minimize', (e) => winOf(e)?.minimize())
  handleSecure('window:toggle-maximize', (e) => {
    const w = winOf(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  handleSecure('window:close', (e) => winOf(e)?.close())
  handleSecure('guide:open', (e, page: unknown, anchor: unknown) =>
    openGuide(page === 'guide' ? 'guide' : 'quick', winOf(e), safeAnchor(anchor))
  )
  handleSecure('dialog:open-pack', async (e) => {
    if (process.env.MIZAJ_E2E_PACK_PATH)
      return dialogPaths.addAndReturn(process.env.MIZAJ_E2E_PACK_PATH)
    const w = winOf(e)
    const opts = {
      properties: ['openFile' as const],
      filters: [{ name: 'Mizaj model pack', extensions: ['mizajpack'] }]
    }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths[0] ? null : dialogPaths.addAndReturn(r.filePaths[0])
  })
  handleSecure('dialog:save-docx', async (e, defaultName: unknown) => {
    // test-only stub for the native dialog
    if (process.env.MIZAJ_E2E_SAVE_PATH)
      return dialogPaths.addAndReturn(process.env.MIZAJ_E2E_SAVE_PATH)
    const w = winOf(e)
    const name =
      typeof defaultName === 'string' && defaultName && defaultName.length <= MAX_NAME_LENGTH
        ? defaultName
        : 'mizaj.docx'
    const opts = {
      defaultPath: name.replace(/[\\/:*?"<>|]/g, '_'),
      filters: [{ name: 'Word', extensions: ['docx'] }]
    }
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    return dialogPaths.addAndReturn(
      r.filePath.toLowerCase().endsWith('.docx') ? r.filePath : `${r.filePath}.docx`
    )
  })
}

export function broadcastStatus(status: SidecarStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('sidecar:status-changed', status)
  }
}
