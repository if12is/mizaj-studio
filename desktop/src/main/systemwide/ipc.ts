import { execFile } from 'node:child_process'
import { join } from 'node:path'
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  globalShortcut,
  nativeImage,
  screen,
  type IpcMainInvokeEvent
} from 'electron'
import { handleSecure } from '../ipcGuard'
import { WinAutomation, type Automation } from './automation'
import { createBackendDeps, type BackendTarget } from './backend'
import { SystemwideConfigStore, applyPatch, type SystemwideConfig } from './config'
import { MockAutomation } from './mockAutomation'
import { OP_IDS } from './pipeline'
import { ShortcutRegistry, type StatusMap } from './registration'
import { SystemwideService, type PopupState } from './service'
import { SHORTCUT_ERROR_AR, SHORTCUT_IDS, type ShortcutId } from './shortcuts'

/**
 * Electron wiring of «مِزَاج في أي برنامج»: global shortcuts, the floating popup, the tray and the
 * IPC for the settings page. All the logic lives in the pure modules next to this file.
 *
 * Privacy / security rules kept here:
 *  - the text is never logged (only event codes); IPC arguments are validated;
 *  - popup channels accept only the popup's own webContents; settings channels never the popup;
 *  - the popup is frameless, sandboxed, context-isolated and loads only the app's own page;
 *  - everything is off until the user enables it; shortcuts are unregistered when disabled and on quit.
 */

export interface SystemwideDeps {
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void }
  getBackend: () => BackendTarget
  /** show (or re-create) the main window */
  showMainWindow: () => void
}

export interface SystemwideController {
  /** true while the app should stay alive without a window (tray mode) */
  backgroundActive(): boolean
  /** the main window's close button should hide it instead of closing */
  shouldHideOnClose(): boolean
  /** destroy the popup window (it is re-created on demand) */
  closePopup(): void
  /** true only when this process must exit because another instance already runs in the tray */
  mustQuit: boolean
  dispose(): void
}

export const CH = {
  getState: 'systemwide:get-state',
  setConfig: 'systemwide:set-config',
  popupReady: 'systemwide:popup-ready',
  popupRun: 'systemwide:popup-run',
  popupApply: 'systemwide:popup-apply',
  popupCancel: 'systemwide:popup-cancel',
  popupResize: 'systemwide:popup-resize',
  popupState: 'systemwide:popup-state'
} as const

const POPUP_W = 440
const POPUP_H = 300

interface StateDto {
  supported: boolean
  platform: string
  config: SystemwideConfig
  shortcuts: StatusMap
  /** Arabic validation errors of the last change, by field */
  errors: Record<string, string>
}

export function registerSystemwide(deps: SystemwideDeps): SystemwideController {
  const mock = !app.isPackaged && process.env.MIZAJ_E2E_SYSTEMWIDE_MOCK === '1'
  const supported = process.platform === 'win32' || mock
  const userData = app.getPath('userData')
  const store = new SystemwideConfigStore(join(userData, 'systemwide-config.json'))
  let config = store.load()
  if (!supported) config = { ...config, enabled: false }
  let statuses: StatusMap | null = null
  let quitting = false
  let popup: BrowserWindow | null = null
  let tray: Tray | null = null
  const notices: { message: string; kind: string }[] = []

  const scriptsDir = app.isPackaged
    ? join(process.resourcesPath, 'systemwide')
    : join(app.getAppPath(), 'resources', 'systemwide')
  const mockAuto = mock ? new MockAutomation() : null
  const automation: Automation =
    mockAuto ??
    new WinAutomation({
      tmpRoot: join(userData, 'systemwide-tmp'),
      scriptsDir,
      exec: (file, args, opts) =>
        new Promise((resolve, reject) => {
          execFile(file, args, opts, (err) => (err ? reject(err) : resolve()))
        })
    })

  const service: SystemwideService = new SystemwideService({
    automation,
    backend: createBackendDeps(deps.getBackend),
    getConfig: () => config,
    hooks: {
      onState: (s) => sendState(s),
      showPopup: () => showPopup(),
      hidePopup: () => popup?.hide(),
      notify: (message, kind) => {
        if (mock) notices.push({ message, kind })
        else if (Notification.isSupported())
          new Notification({ title: 'مِزَاج', body: message, silent: kind === 'info' }).show()
      },
      log: (e) => deps.log.info(`systemwide: ${e}`) // event codes only, never text
    }
  })

  // ---- single instance (only when running in the background, so default behaviour is unchanged)
  let mustQuit = false
  if (config.runInBackground) {
    if (!app.requestSingleInstanceLock()) mustQuit = true
    else app.on('second-instance', () => deps.showMainWindow())
  }

  // ---- shortcuts
  const registry = new ShortcutRegistry(
    {
      register: (acc, cb) => globalShortcut.register(acc, cb),
      unregister: (acc) => globalShortcut.unregister(acc)
    },
    (id) => void service.trigger(id === 'main' ? 'main' : id)
  )

  function syncTray(): void {
    if (config.runInBackground && !tray) {
      try {
        const icon = nativeImage
          .createFromPath(
            app.isPackaged
              ? join(process.resourcesPath, 'tray.png')
              : join(app.getAppPath(), 'build', 'icon.png')
          )
          .resize({ width: 16, height: 16 })
        if (icon.isEmpty()) throw new Error('tray icon missing')
        tray = new Tray(icon)
        tray.setToolTip('مِزَاج ستوديو')
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: 'فتح مِزَاج', click: () => deps.showMainWindow() },
            { type: 'separator' },
            { label: 'خروج', click: () => app.quit() }
          ])
        )
        tray.on('click', () => deps.showMainWindow())
      } catch (e) {
        tray = null
        deps.log.warn('systemwide: tray unavailable', e instanceof Error ? e.message : '')
      }
    } else if (!config.runInBackground && tray) {
      tray.destroy()
      tray = null
    }
  }

  function applyConfig(): void {
    if (service.active && !config.enabled) service.cancel(false)
    statuses = registry.apply(config)
    syncTray()
  }

  function dto(errors: Record<string, string> = {}): StateDto {
    return {
      supported,
      platform: process.platform,
      config,
      shortcuts: statuses ?? registry.apply({ ...config, enabled: false }),
      errors
    }
  }

  // ---- popup window
  function ensurePopup(): BrowserWindow {
    if (popup && !popup.isDestroyed()) return popup
    const w = new BrowserWindow({
      width: POPUP_W,
      height: POPUP_H,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
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
    w.setAlwaysOnTop(true, 'pop-up-menu')
    w.setMenuBarVisibility(false)
    // Navigation / window.open are locked down for all webContents in hardening.ts.
    if (process.env.ELECTRON_RENDERER_URL)
      void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}?popup=1`)
    else void w.loadFile(join(__dirname, '../renderer/index.html'), { query: { popup: '1' } })
    w.on('blur', () => {
      // clicking another program dismisses the popup (not while a replacement is running)
      const ph = service.getState()?.phase
      if (!mock && w.isVisible() && ph && ph !== 'applying' && ph !== 'running')
        service.cancel(false)
    })
    w.on('closed', () => {
      if (popup === w) popup = null
    })
    popup = w
    return w
  }

  function place(w: BrowserWindow): void {
    const pt = screen.getCursorScreenPoint()
    const wa = screen.getDisplayNearestPoint(pt).workArea
    const [width, height] = w.getSize()
    const x = Math.min(Math.max(pt.x + 10, wa.x), wa.x + wa.width - width)
    const y = Math.min(Math.max(pt.y + 14, wa.y), wa.y + wa.height - height)
    w.setPosition(Math.round(x), Math.round(y))
  }

  function showPopup(): void {
    const w = ensurePopup()
    const reveal = (): void => {
      if (w.isDestroyed()) return
      place(w)
      w.show()
      w.focus()
      // Windows may refuse to hand the focus to a window shown a moment after another program's
      // keystrokes; the popup reads the keys 1-4 / Enter / Esc, so make sure it really has the focus
      // (otherwise those keys would be typed into the user's document).
      if (!mock) {
        setTimeout(() => {
          if (w.isDestroyed() || !w.isVisible() || w.isFocused()) return
          const b = w.getNativeWindowHandle()
          const hwnd = b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0)
          void automation.focus({ hwnd, pid: 0, exe: '', elevated: false }).catch(() => undefined)
        }, 120)
      }
    }
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal)
    else reveal()
  }

  function sendState(s: PopupState): void {
    if (popup && !popup.isDestroyed() && !popup.webContents.isLoading())
      popup.webContents.send(CH.popupState, s)
  }

  const fromPopup = (e: IpcMainInvokeEvent): boolean =>
    !!popup && !popup.isDestroyed() && e.sender === popup.webContents
  const guardPopup = (e: IpcMainInvokeEvent): void => {
    if (!fromPopup(e)) throw new Error('systemwide: not the popup')
  }

  // ---- IPC (settings page)
  handleSecure(CH.getState, (e) => {
    if (fromPopup(e)) throw new Error('systemwide: popup may not read settings')
    return dto()
  })
  handleSecure(CH.setConfig, (e, patch: unknown) => {
    if (fromPopup(e)) throw new Error('systemwide: popup may not change settings')
    const r = applyPatch(config, patch)
    const errors: Record<string, string> = {}
    for (const id of SHORTCUT_IDS) {
      const code = r.errors[id]
      if (code) errors[id] = SHORTCUT_ERROR_AR[code]
    }
    if (r.errors.replaceMode) errors.replaceMode = 'قيمة غير صالحة لطريقة الاستبدال.'
    if (r.errors.enabled) errors.enabled = 'قيمة غير صالحة.'
    config = r.config
    if (!supported) config = { ...config, enabled: false }
    try {
      store.save(config)
    } catch (err) {
      deps.log.warn('systemwide: could not save config', err instanceof Error ? err.message : '')
      errors.save = 'تعذّر حفظ الإعداد على القرص.'
    }
    applyConfig()
    return dto(errors)
  })

  // ---- IPC (popup)
  handleSecure(CH.popupReady, (e) => {
    guardPopup(e)
    return service.getState()
  })
  handleSecure(CH.popupRun, async (e, op: unknown) => {
    guardPopup(e)
    if (typeof op !== 'string' || !OP_IDS.includes(op as (typeof OP_IDS)[number])) return
    await service.run(op)
  })
  handleSecure(CH.popupApply, async (e) => {
    guardPopup(e)
    await service.apply()
  })
  handleSecure(CH.popupCancel, (e) => {
    guardPopup(e)
    service.cancel()
  })
  handleSecure(CH.popupResize, (e, h: unknown) => {
    guardPopup(e)
    if (typeof h !== 'number' || !Number.isFinite(h) || !popup || popup.isDestroyed()) return
    popup.setSize(POPUP_W, Math.min(620, Math.max(180, Math.round(h))))
    place(popup)
  })

  // ---- test hook (unpackaged + explicit env only; never exists in a release build)
  if (mock && mockAuto) {
    ;(globalThis as Record<string, unknown>).__mizajSystemwide = {
      auto: mockAuto,
      notices,
      trigger: (id: ShortcutId) => service.trigger(id === 'main' ? 'main' : id),
      state: () => service.getState(),
      registered: () => registry.registered,
      fire: (acc: string) => {
        // simulate the OS delivering a shortcut that this app registered
        const id = SHORTCUT_IDS.find((i) => dto().shortcuts[i].accelerator === acc)
        if (id) void service.trigger(id === 'main' ? 'main' : id)
      }
    }
  }

  app.on('before-quit', () => {
    quitting = true
  })
  const dispose = (): void => {
    registry.unregisterAll()
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
  }
  app.on('will-quit', dispose)

  if (!mustQuit) {
    void app.whenReady().then(() => {
      applyConfig()
      deps.log.info(`systemwide: ${config.enabled ? 'enabled' : 'off'}`)
    })
  }

  return {
    backgroundActive: () => config.runInBackground && !quitting && tray !== null,
    shouldHideOnClose: () => config.runInBackground && !quitting && tray !== null,
    mustQuit,
    closePopup: () => {
      if (popup && !popup.isDestroyed()) popup.destroy()
      popup = null
    },
    dispose
  }
}
