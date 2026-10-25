import { app, BrowserWindow, Menu, net, powerMonitor, session, shell } from 'electron'
import { EventEmitter } from 'node:events'
import { autoUpdater } from 'electron-updater'
import { resolve } from 'node:path'
import { initLogger, registerSecret } from './logger'
import { handleSecure, configureIpcGuard } from './ipcGuard'
import { hardenSession, hardenWebContents } from './hardening'
import { generateApiToken, isAllowedExternalUrl, type AppLocation } from './security'
import { cleanupUserData, restrictPermissions } from './userData'
import { setFileIpcLogger } from './fileIpc'
import { isPortable, resolveUserDataDir } from './paths'
import { registerDiagnostics } from './diagnosticsIpc'
import { registerGemini } from './gemini/ipc'
import { PythonProcessManager, resolveSidecar, STATUS_EVENT } from './pythonManager'
import {
  broadcastStatus,
  createMainWindow,
  registerIpc,
  requestFlush,
  setHideOnClose,
  setOnMainClosed,
  showMainWindow
} from './window'
import { registerSystemwide } from './systemwide/ipc'
import { registerWordAddin } from './wordaddin/ipc'
import { UPDATER_STATUS_CHANNEL, UpdaterController, type UpdaterLike } from './updater'

// Tests only: isolate user data (must run before anything reads userData).
const userDataOverride = resolveUserDataDir(process.env)
if (userDataOverride) app.setPath('userData', userDataOverride)

const log = initLogger()

// One random API token per app launch; the sidecar gets it via env, the renderer via IPC only.
const apiToken = generateApiToken()
registerSecret(apiToken)
// Test-only convention: lets e2e read the token via app.evaluate(() => process.env.MIZAJ_API_TOKEN).
// Otherwise it is never placed in the main process env (only in the sidecar's child env).
if (process.env.MIZAJ_E2E_EXPOSE_TOKEN === '1') process.env.MIZAJ_API_TOKEN = apiToken
else delete process.env.MIZAJ_API_TOKEN

// Test-only: a fake piper executable for the read-aloud E2E. The sidecar honours it only together
// with MIZAJ_ALLOW_TEST_HOOKS=1, which is set here for UNPACKAGED builds only; packaged builds
// strip both so a user's environment can never redirect Piper to another program.
// MIZAJ_E2E_FAKE_DOWNLOAD (resources E2E): the downloader writes placeholder bytes instead of
// using the network; same rule.
if (!app.isPackaged && (process.env.MIZAJ_E2E_FAKE_PIPER || process.env.MIZAJ_E2E_FAKE_DOWNLOAD))
  process.env.MIZAJ_ALLOW_TEST_HOOKS = '1'
else {
  delete process.env.MIZAJ_ALLOW_TEST_HOOKS
  delete process.env.MIZAJ_E2E_FAKE_PIPER
  delete process.env.MIZAJ_E2E_FAKE_DOWNLOAD
}

const appLocation: AppLocation = {
  rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
  indexHtmlPath: resolve(__dirname, '../renderer/index.html')
}
configureIpcGuard(appLocation, (...a) => log.warn(...a))
setFileIpcLogger((...a) => log.warn(...a))
hardenWebContents(appLocation, log, (url) => {
  if (isAllowedExternalUrl(url)) void shell.openExternal(url)
})
restrictPermissions(app.getPath('userData'))
{
  const { removed } = cleanupUserData(app.getPath('userData'))
  if (removed.length) log.info(`cleaned ${removed.length} leftover temp item(s) in userData`)
}

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
  apiToken,
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
// Test-only: CI's update E2E serves locally built releases from a generic feed instead of GitHub.
if (app.isPackaged && process.env.MIZAJ_UPDATE_FEED_URL) {
  autoUpdater.setFeedURL({ provider: 'generic', url: process.env.MIZAJ_UPDATE_FEED_URL })
}
const updater = new UpdaterController({
  updater: (app.isPackaged ? autoUpdater : new StubUpdater()) as unknown as UpdaterLike,
  isPackaged: app.isPackaged,
  portable: isPortable(process.env),
  logger: log as never,
  isOnline: () => net.isOnline(),
  subscribeWake: (cb) => {
    let active = true
    const handler = (): void => {
      if (active) cb()
    }
    void app.whenReady().then(() => powerMonitor.on('resume', handler)) // not usable before ready
    return () => {
      active = false
      if (app.isReady()) powerMonitor.removeListener('resume', handler)
    }
  },
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
handleSecure('updater:get-status', () => updater.getStatus())
handleSecure('updater:check', () => updater.check(true))
handleSecure('updater:download', () => updater.download())
handleSecure('updater:install', () => updater.installNow())
handleSecure('updater:set-auto-check', (_e, enabled: unknown) =>
  updater.setAutoCheck(enabled === true)
)
app.on('browser-window-focus', () => updater.notifyFocus())
app.on('will-quit', (e) => {
  if (sidecarStopped) return
  e.preventDefault()
  void manager.stop().finally(() => {
    sidecarStopped = true
    app.quit()
  })
})

// «مِزَاج في أي برنامج» (opt-in, off by default): global shortcuts, popup, tray / background mode
const systemwide = registerSystemwide({
  log,
  getBackend: () => ({
    baseUrl: manager.getStatus().port ? `http://127.0.0.1:${manager.getStatus().port}` : null,
    token: apiToken
  }),
  showMainWindow
})
// Word add-in (opt-in, off by default): HTTPS host on https://localhost for the ribbon add-in
registerWordAddin({
  log,
  getBackend: () => ({
    baseUrl: manager.getStatus().port ? `http://127.0.0.1:${manager.getStatus().port}` : null,
    token: apiToken
  })
})
setHideOnClose(() => systemwide.shouldHideOnClose())
// the (hidden) popup must not keep the app alive once the main window is really closed
setOnMainClosed(() => systemwide.closePopup())

app.on('window-all-closed', () => {
  if (!systemwide.backgroundActive()) app.quit()
})

// Remove Electron's default menu: its accelerators (e.g. Ctrl+Shift+R "Force Reload")
// would shadow the editor shortcuts. The window is frameless, so no menu is shown anyway.
Menu.setApplicationMenu(
  process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
    : null
)

registerDiagnostics({ manager, log, portable: isPortable(process.env), apiToken })
registerGemini()

if (systemwide.mustQuit) {
  // another instance already runs in the tray: it shows its window (second-instance), this one exits
  app.quit()
} else
  void app.whenReady().then(() => {
    log.info('Mizaj Studio starting, userData=', app.getPath('userData'))
    hardenSession(session.defaultSession, appLocation, log)
    registerIpc(() => manager.getStatus(), apiToken)
    manager.start()
    createMainWindow()
    updater.start()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
