import type { EventEmitter } from 'node:events'

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'retrying'
  | 'error'

export interface UpdaterStatus {
  state: UpdaterState
  version?: string
  percent?: number
  bytesPerSecond?: number
  message?: string
  /** 'not-packaged' when updates are requested from a development run */
  code?: 'not-packaged' | 'portable'
  /** state 'retrying': what is being retried, which failure this is, and when the next try runs. */
  phase?: 'check' | 'download'
  attempt?: number
  maxAttempts?: number
  /** epoch ms of the next automatic try; null while waiting for the network to come back */
  nextRetryAt?: number | null
  offline?: boolean
}

/** Delays before retry 1..5 after a network failure (30 s, 2 min, 10 min, 10 min, 10 min). */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 600_000, 600_000]
export const OFFLINE_POLL_MS = 10_000

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE'
])
const RETRYABLE_MESSAGE =
  /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_\w+|TIMED_OUT|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|NETWORK_IO_SUSPENDED|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|PROXY_CONNECTION_FAILED|CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING|HTTP2_\w+)|socket hang up|premature close|request aborted|operation was aborted|\btimed out\b|ECONN\w+|ENOTFOUND|EAI_AGAIN|sha512 checksum mismatch|file size mismatch|size mismatch/i

/**
 * Network trouble (or a truncated/corrupt download, which electron-updater deletes) is worth
 * another try; 4xx answers (no such release, forbidden) and parse errors are not.
 */
export function isRetryableUpdateError(e: unknown): boolean {
  const err = e as { code?: unknown; statusCode?: unknown; message?: unknown } | null
  if (!err) return false
  if (typeof err.code === 'string' && RETRYABLE_CODES.has(err.code)) return true
  const status = typeof err.statusCode === 'number' ? err.statusCode : undefined
  if (status !== undefined) return status === 408 || status === 429 || status >= 500
  // first line only: electron-updater appends response headers (e.g. 'Keep-Alive: timeout=5') below it
  const msg = (typeof err.message === 'string' ? err.message : String(e)).split('\n')[0]
  const http = /\b(?:HTTP|status(?: code)?)\s*[: ]?\s*(\d{3})\b/i.exec(msg)
  if (http) {
    const n = Number(http[1])
    return n === 408 || n === 429 || n >= 500
  }
  return RETRYABLE_MESSAGE.test(msg)
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
  /** portable build: a self-updating portable exe is impossible, updates are disabled */
  portable?: boolean
  send: (status: UpdaterStatus) => void
  /** Ask the renderer(s) to flush autosave (resolves after reply or timeout). */
  flushRenderer: () => Promise<void>
  /** Stop the Python sidecar and wait until it is gone. */
  stopSidecar: () => Promise<void>
  logger?: LoggerLike & Record<string, unknown>
  /** Network reachability (net.isOnline). Default: assume online. */
  isOnline?: () => boolean
  /** Subscribe to "the machine woke up / network may be back" hints (powerMonitor 'resume'). */
  subscribeWake?: (cb: () => void) => () => void
  retryDelaysMs?: number[]
  now?: () => number
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
  private failures = 0
  private errorSeq = 0
  private retryPhase: 'check' | 'download' | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private offlineTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribeWake: (() => void) | null = null
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
    u.on('update-available', (info: { version: string }) => {
      this.resetRetry()
      this.set({ state: 'available', version: info.version })
    })
    u.on('update-not-available', () => {
      this.resetRetry()
      this.set({ state: 'not-available' })
    })
    u.on('download-progress', (p: { percent: number; bytesPerSecond: number }) =>
      this.set({
        state: 'downloading',
        version: this.status.version,
        percent: Math.round(p.percent),
        bytesPerSecond: p.bytesPerSecond
      })
    )
    u.on('update-downloaded', (info: { version: string }) => {
      this.resetRetry()
      this.set({ state: 'downloaded', version: info.version })
    })
    u.on('error', (e: Error) => this.onFailure(e))
    this.unsubscribeWake = d.subscribeWake?.(() => this.retryNow()) ?? null
  }

  private get delays(): number[] {
    return this.d.retryDelaysMs ?? RETRY_DELAYS_MS
  }

  private online(): boolean {
    try {
      return this.d.isOnline ? this.d.isOnline() : true
    } catch {
      return true
    }
  }

  /** Single funnel for the 'error' event and rejected promises. */
  private onFailure(e: unknown): void {
    this.errorSeq++
    this.d.logger?.error('updater error', e)
    const phase: 'check' | 'download' =
      this.retryPhase ?? (this.status.state === 'downloading' ? 'download' : 'check')
    // Background checks fail silently (offline is normal); manual/download errors are shown.
    const visible = this.manual || phase === 'download'
    if (isRetryableUpdateError(e) || !this.online()) {
      if (this.scheduleRetry(phase, e, visible)) return
    }
    this.resetRetry()
    if (visible) this.set({ state: 'error', message: (e as Error)?.message ?? String(e) })
    else this.set({ state: 'idle' })
  }

  /** Returns false when the retry budget is spent. */
  private scheduleRetry(phase: 'check' | 'download', e: unknown, visible: boolean): boolean {
    this.clearRetryTimers()
    this.failures++
    const max = this.delays.length
    if (this.failures > max) return false
    this.retryPhase = phase
    const offline = !this.online()
    const base: UpdaterStatus = {
      state: 'retrying',
      phase,
      version: this.status.version,
      percent: this.status.percent,
      attempt: this.failures,
      maxAttempts: max,
      message: (e as Error)?.message ?? String(e)
    }
    if (offline) {
      // Wait for connectivity without burning the retry budget.
      this.failures--
      this.startOfflinePoll()
      if (visible) this.set({ ...base, attempt: this.failures, nextRetryAt: null, offline: true })
      return true
    }
    const delay = this.delays[this.failures - 1]
    const nextRetryAt = (this.d.now ?? Date.now)() + delay
    this.retryTimer = (this.d.setTimeoutFn ?? setTimeout)(() => this.retryNow(), delay)
    this.d.logger?.info(`updater: ${phase} failed, retry ${this.failures}/${max} in ${delay} ms`)
    if (visible) this.set({ ...base, nextRetryAt, offline: false })
    else this.set({ state: 'idle' })
    return true
  }

  private startOfflinePoll(): void {
    if (this.offlineTimer) return
    this.offlineTimer = (this.d.setIntervalFn ?? setInterval)(() => {
      if (this.online()) this.retryNow()
    }, OFFLINE_POLL_MS)
  }

  private clearRetryTimers(): void {
    if (this.retryTimer) (this.d.clearTimeoutFn ?? clearTimeout)(this.retryTimer)
    if (this.offlineTimer) (this.d.clearIntervalFn ?? clearInterval)(this.offlineTimer)
    this.retryTimer = null
    this.offlineTimer = null
  }

  private resetRetry(): void {
    this.clearRetryTimers()
    this.failures = 0
    this.retryPhase = null
  }

  /** Timer fired, network came back, machine woke up, or the user pressed "check" again. */
  private retryNow(): void {
    const phase = this.retryPhase
    if (!phase) return
    if (!this.online()) {
      // Woken while still offline: swap the backoff timer for the connectivity poller.
      if (this.retryTimer) (this.d.clearTimeoutFn ?? clearTimeout)(this.retryTimer)
      this.retryTimer = null
      this.startOfflinePoll()
      return
    }
    this.clearRetryTimers()
    const seq = this.errorSeq
    const run =
      phase === 'download'
        ? (() => {
            this.set({
              state: 'downloading',
              version: this.status.version,
              percent: this.status.percent ?? 0
            })
            return this.d.updater.downloadUpdate()
          })()
        : this.d.updater.checkForUpdates()
    Promise.resolve(run).catch((e) => {
      if (this.errorSeq === seq) this.onFailure(e) // no 'error' event was emitted for it
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
    if (!this.d.isPackaged || this.d.portable) return
    const st = this.d.setTimeoutFn ?? setTimeout
    const si = this.d.setIntervalFn ?? setInterval
    this.timers.first = st(() => {
      this.firstDelayElapsed = true
      this.tick()
    }, FIRST_CHECK_DELAY_MS)
    this.timers.every = si(() => this.tick(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    this.clearRetryTimers()
    this.unsubscribeWake?.()
    this.unsubscribeWake = null
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
    if (this.autoCheck !== true || !this.d.isPackaged || this.d.portable) return
    this.autoChecked = true
    void this.check(false)
  }

  /** Manual checks work regardless of the toggle. */
  async check(manual: boolean): Promise<UpdaterStatus> {
    if (!this.d.isPackaged || this.d.portable) {
      if (manual) this.set({ state: 'idle', code: this.d.portable ? 'portable' : 'not-packaged' })
      return this.status
    }
    if (this.status.state === 'retrying' || this.retryPhase) {
      // A manual "check now" short-circuits the backoff; automatic ticks leave it alone.
      if (manual) {
        this.manual = true
        this.retryNow()
      }
      return this.status
    }
    const busy = this.status.state === 'checking' || this.status.state === 'downloading'
    if (busy || this.status.state === 'downloaded') return this.status
    this.manual = manual
    const seq = this.errorSeq
    try {
      await this.d.updater.checkForUpdates()
    } catch (e) {
      // 'error' event normally already reported it
      this.d.logger?.warn('checkForUpdates rejected', e)
      if (this.errorSeq === seq) this.onFailure(e)
    }
    return this.status
  }

  async download(): Promise<void> {
    if (this.status.state !== 'available') return
    this.manual = true
    this.retryPhase = 'download'
    this.set({ state: 'downloading', version: this.status.version, percent: 0 })
    const seq = this.errorSeq
    try {
      await this.d.updater.downloadUpdate()
    } catch (e) {
      this.d.logger?.warn('downloadUpdate rejected', e)
      if (this.errorSeq === seq) this.onFailure(e)
    }
  }

  /**
   * flush autosave -> stop sidecar -> quitAndInstall(true, true).
   * Silent: the assisted (oneClick: false) NSIS installer would otherwise show its wizard
   * and wait for clicks during an update; silent installs into the existing location and
   * relaunches the app.
   */
  async installNow(): Promise<void> {
    if (this.status.state !== 'downloaded') return
    await this.d.flushRenderer()
    await this.d.stopSidecar()
    this.stop()
    this.d.updater.quitAndInstall(true, true)
  }
}
