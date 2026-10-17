import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { SidecarStatus } from './pythonManager'

export const FLUSH_TIMEOUT_MS = 2000

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
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')) {
      e.preventDefault()
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  attachFlushOnClose(win)
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
      if (e.sender.id === id) done()
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
      flushed = true
      if (!win.isDestroyed()) win.close()
    })
  })
}

export function registerIpc(getStatus: () => SidecarStatus): void {
  const winOf = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)
  ipcMain.handle('backend:get-config', () => {
    const s = getStatus()
    return {
      port: s.port,
      baseUrl: s.port ? `http://127.0.0.1:${s.port}` : null,
      status: s
    }
  })
  ipcMain.handle('window:minimize', (e) => winOf(e)?.minimize())
  ipcMain.handle('window:toggle-maximize', (e) => {
    const w = winOf(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle('window:close', (e) => winOf(e)?.close())
}

export function broadcastStatus(status: SidecarStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('sidecar:status-changed', status)
  }
}
