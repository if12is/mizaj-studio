import { app, BrowserWindow, Menu } from 'electron'
import { resolve } from 'node:path'
import { initLogger } from './logger'
import { PythonProcessManager, resolveSidecar, STATUS_EVENT } from './pythonManager'
import { broadcastStatus, createMainWindow, registerIpc } from './window'

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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})
