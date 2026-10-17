import type { EventEmitter } from 'node:events'

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdaterStatus {
  state: UpdaterState
  version?: string
  percent?: number
  bytesPerSecond?: number
  message?: string
  /** 'not-packaged' when updates are requested from a development run */
  code?: 'not-packaged'
}

export const UPDATER_STATUS_CHANNEL = 'updater:status'
export const FIRST_CHECK_DELAY_MS = 10_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** The subset of electron-updater's AppUpdater we use (fakeable in tests). */
export interface UpdaterLike extends EventEmitter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  logger: unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface LoggerLike {
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
  error(...a: unknown[]): void
}

export interface UpdaterDeps {
  updater: UpdaterLike
  isPackaged: boolean
  send: (status: UpdaterStatus) => void
  /** Ask the renderer(s) to flush autosave (resolves after reply or timeout). */
  flushRenderer: () => Promise<void>
  /** Stop the Python sidecar and wait until it is gone. */
  stopSidecar: () => Promise<void>
  logger?: LoggerLike & Record<string, unknown>
  setTimeoutFn?: typeof setTimeout
  setIntervalFn?: typeof setInterval
  clearTimeoutFn?: typeof clearTimeout
  clearIntervalFn?: typeof clearInterval
}

/**
 * In-app updater (GitHub Releases through electron-updater).
 * The ONLY automatic network access in the app; it runs only when packaged and
 * only if the user has not disabled `auto_update_check`. The renderer pushes
 * that setting over IPC (setAutoCheck); until it has, no automatic check runs.
 */
export class UpdaterController {
  private status: UpdaterStatus = { state: 'idle' }
  private autoCheck: boolean | null = null
  private firstDelayElapsed = false
  private autoChecked = false
  private manual = false
  private timers: {
    first?: ReturnType<typeof setTimeout>
    every?: ReturnType<typeof setInterval>
  } = {}

  constructor(private readonly d: UpdaterDeps) {
    const u = d.updater
    u.autoDownload = false
    u.autoInstallOnAppQuit = false
    u.allowDowngrade = false
    if (d.logger) u.logger = d.logger
    u.on('checking-for-update', () => this.set({ state: 'checking' }))
    u.on('update-available', (info: { version: string }) =>
      this.set({ state: 'available', version: info.version })
    )
    u.on('update-not-available', () => this.set({ state: 'not-available' }))
    u.on('download-progress', (p: { percent: number; bytesPerSecond: number }) =>
      this.set({
        state: 'downloading',
        version: this.status.version,
        percent: Math.round(p.percent),
        bytesPerSecond: p.bytesPerSecond
      })
    )
    u.on('update-downloaded', (info: { version: string }) =>
      this.set({ state: 'downloaded', version: info.version })
    )
    u.on('error', (e: Error) => {
      this.d.logger?.error('updater error', e)
      // Background checks fail silently (offline is normal); manual/download errors are shown.
      if (this.manual || this.status.state === 'downloading') {
        this.set({ state: 'error', message: e?.message ?? String(e) })
      } else {
        this.set({ state: 'idle' })
      }
    })
  }

  getStatus(): UpdaterStatus {
    return this.status
  }

  private set(s: UpdaterStatus): void {
    this.status = s
    this.d.send(s)
  }

  /** Schedule: first automatic check after 10s, then every 6h (packaged only). */
  start(): void {
    if (!this.d.isPackaged) return
    const st = this.d.setTimeoutFn ?? setTimeout
    const si = this.d.setIntervalFn ?? setInterval
    this.timers.first = st(() => {
      this.firstDelayElapsed = true
      this.tick()
    }, FIRST_CHECK_DELAY_MS)
    this.timers.every = si(() => this.tick(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timers.first) (this.d.clearTimeoutFn ?? clearTimeout)(this.timers.first)
    if (this.timers.every) (this.d.clearIntervalFn ?? clearInterval)(this.timers.every)
    this.timers = {}
  }

  setAutoCheck(enabled: boolean): void {
    const was = this.autoCheck
    this.autoCheck = enabled
    // The setting arrived after the initial delay (slow backend start): do the first check now.
    if (enabled && was !== true && this.firstDelayElapsed && !this.autoChecked) this.tick()
  }

  private tick(): void {
    if (this.autoCheck !== true || !this.d.isPackaged) return
    this.autoChecked = true
    void this.check(false)
  }

  /** Manual checks work regardless of the toggle. */
  async check(manual: boolean): Promise<UpdaterStatus> {
    if (!this.d.isPackaged) {
      if (manual) this.set({ state: 'idle', code: 'not-packaged' })
      return this.status
    }
    const busy = this.status.state === 'checking' || this.status.state === 'downloading'
    if (busy || this.status.state === 'downloaded') return this.status
    this.manual = manual
    try {
      await this.d.updater.checkForUpdates()
    } catch (e) {
      // 'error' event normally already reported it
      this.d.logger?.warn('checkForUpdates rejected', e)
    }
    return this.status
  }

  async download(): Promise<void> {
    if (this.status.state !== 'available') return
    this.manual = true
    this.set({ state: 'downloading', version: this.status.version, percent: 0 })
    try {
      await this.d.updater.downloadUpdate()
    } catch (e) {
      this.d.logger?.warn('downloadUpdate rejected', e)
    }
  }

  /** flush autosave -> stop sidecar -> quitAndInstall(false, true). */
  async installNow(): Promise<void> {
    if (this.status.state !== 'downloaded') return
    await this.d.flushRenderer()
    await this.d.stopSidecar()
    this.stop()
    this.d.updater.quitAndInstall(false, true)
  }
}
