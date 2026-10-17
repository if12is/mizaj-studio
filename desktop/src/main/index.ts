import { app, BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import { initLogger } from './logger'
import { PythonProcessManager, resolvePythonExe, STATUS_EVENT } from './pythonManager'
import { broadcastStatus, createMainWindow, registerIpc } from './window'

const log = initLogger()

const backendDir = resolve(app.getAppPath(), '..', 'backend')
const manager = new PythonProcessManager({
  pythonExe: resolvePythonExe(process.env, backendDir),
  backendDir,
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

void app.whenReady().then(() => {
  log.info('Mizaj Studio starting, userData=', app.getPath('userData'))
  registerIpc(() => manager.getStatus())
  manager.start()
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})
