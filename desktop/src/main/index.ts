import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { EventEmitter } from 'node:events'
import { autoUpdater } from 'electron-updater'
import { resolve } from 'node:path'
import { initLogger } from './logger'
import { PythonProcessManager, resolveSidecar, STATUS_EVENT } from './pythonManager'
import { broadcastStatus, createMainWindow, registerIpc, requestFlush } from './window'
import { UPDATER_STATUS_CHANNEL, UpdaterController, type UpdaterLike } from './updater'

// Tests only: isolate user data (must run before anything reads userData).
if (process.env.MIZAJ_USER_DATA_DIR) app.setPath('userData', process.env.MIZAJ_USER_DATA_DIR)

const log = initLogger()

const backendDir = resolve(app.getAppPath(), '..', 'backend')
const target = resolveSidecar({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  backendDir,
  userDataDir: app.getPath('userData'),
  env: process.env
})
const manager = new PythonProcessManager({
  pythonExe: target.pythonExe,
  backendDir: target.backendDir,
  prefixArgs: target.prefixArgs,
  extraEnv: target.extraEnv,
  dataDir: app.getPath('userData'),
  logger: log
})
manager.on(STATUS_EVENT, broadcastStatus)

let sidecarStopped = false

// In development electron-updater is never touched (no app-update.yml); a stub keeps the API uniform.
class StubUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowDowngrade = false
  logger: unknown = null
  async checkForUpdates(): Promise<null> {
    return null
  }
  async downloadUpdate(): Promise<never[]> {
    return []
  }
  quitAndInstall(): void {}
}
const updater = new UpdaterController({
  updater: (app.isPackaged ? autoUpdater : new StubUpdater()) as unknown as UpdaterLike,
  isPackaged: app.isPackaged,
  logger: log as never,
  send: (s) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(UPDATER_STATUS_CHANNEL, s)
    }
  },
  flushRenderer: async () => {
    await Promise.all(BrowserWindow.getAllWindows().map((w) => requestFlush(w)))
  },
  stopSidecar: async () => {
    await manager.stop()
    sidecarStopped = true // let will-quit proceed straight to quit so the installer can run
  }
})
ipcMain.handle('updater:get-status', () => updater.getStatus())
ipcMain.handle('updater:check', () => updater.check(true))
ipcMain.handle('updater:download', () => updater.download())
ipcMain.handle('updater:install', () => updater.installNow())
ipcMain.handle('updater:set-auto-check', (_e, enabled: unknown) =>
  updater.setAutoCheck(enabled === true)
)
app.on('will-quit', (e) => {
  if (sidecarStopped) return
  e.preventDefault()
  void manager.stop().finally(() => {
    sidecarStopped = true
    app.quit()
  })
})

app.on('window-all-closed', () => app.quit())

// Remove Electron's default menu: its accelerators (e.g. Ctrl+Shift+R "Force Reload")
// would shadow the editor shortcuts. The window is frameless, so no menu is shown anyway.
Menu.setApplicationMenu(
  process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
    : null
)

void app.whenReady().then(() => {
  log.info('Mizaj Studio starting, userData=', app.getPath('userData'))
  registerIpc(() => manager.getStatus())
  manager.start()
  createMainWindow()
  updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})
