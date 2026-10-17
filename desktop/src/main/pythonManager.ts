import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { posix, win32 } from 'node:path'

export type SidecarState = 'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped'

export interface SidecarStatus {
  state: SidecarState
  port: number | null
  retry: number
  message?: string
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess

export interface LoggerLike {
  debug(...a: unknown[]): void
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
  error(...a: unknown[]): void
}

export interface PythonManagerOptions {
  pythonExe: string
  backendDir: string
  dataDir: string
  spawn?: SpawnFn
  logger?: LoggerLike
  /** Backoff delays between restarts; its length is also the max retry count. */
  retryDelaysMs?: number[]
  startupTimeoutMs?: number
  stableAfterMs?: number
  killGraceMs?: number
  platform?: NodeJS.Platform
  /** Arguments placed before the sidecar CLI args (dev: ['-m','app.main']; packaged: []). */
  prefixArgs?: string[]
  /** Extra environment for the child process. */
  extraEnv?: Record<string, string>
  /** Per-launch API token, passed ONLY via the MIZAJ_API_TOKEN env var (never argv: visible in process lists). */
  apiToken?: string
  /** Windows tree kill (taskkill). Injectable for tests. */
  killTree?: (pid: number) => void
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export const STATUS_EVENT = 'sidecar:status-changed'

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} }

/** Path helpers for the target platform (not the host), so resolution is testable anywhere. */
function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

export function resolvePythonExe(
  env: NodeJS.ProcessEnv,
  backendDir: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync
): string {
  if (env.MIZAJ_PYTHON) return env.MIZAJ_PYTHON
  const { join } = pathFor(platform)
  const venv =
    platform === 'win32'
      ? join(backendDir, '.venv', 'Scripts', 'python.exe')
      : join(backendDir, '.venv', 'bin', 'python')
  if (exists(venv)) return venv
  return platform === 'win32' ? 'python' : 'python3'
}

export interface SidecarTarget {
  pythonExe: string
  backendDir: string
  prefixArgs: string[]
  extraEnv: Record<string, string>
}

export interface ResolveSidecarInput {
  isPackaged: boolean
  resourcesPath: string
  /** <repo>/backend in development */
  backendDir: string
  userDataDir: string
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exists?: (p: string) => boolean
}

/**
 * Packaged: run the frozen engine directly (no Python) from <resources>/engine.
 * MIZAJ_MODELS_DIR points at the bundled models unless a pack was installed
 * into <userData>/models (the backend gives the user-data pack precedence only
 * when the env var is unset). Dev: python -m app.main from backend/.
 */
export function resolveSidecar(i: ResolveSidecarInput): SidecarTarget {
  const platform = i.platform ?? process.platform
  const exists = i.exists ?? existsSync
  if (!i.isPackaged) {
    return {
      pythonExe: resolvePythonExe(i.env, i.backendDir, platform, exists),
      backendDir: i.backendDir,
      prefixArgs: ['-m', 'app.main'],
      extraEnv: {}
    }
  }
  const { join } = pathFor(platform)
  const engineDir = join(i.resourcesPath, 'engine')
  const exe = join(engineDir, platform === 'win32' ? 'mizaj-engine.exe' : 'mizaj-engine')
  const extraEnv: Record<string, string> = {}
  if (!exists(join(i.userDataDir, 'models'))) {
    extraEnv.MIZAJ_MODELS_DIR = join(i.resourcesPath, 'models', 'catt_eo')
  }
  return { pythonExe: exe, backendDir: engineDir, prefixArgs: [], extraEnv }
}

export class PythonProcessManager extends EventEmitter {
  private readonly opts: Required<Omit<PythonManagerOptions, 'killTree' | 'apiToken'>> & {
    killTree?: (pid: number) => void
    apiToken?: string
  }
  private child: ChildProcess | null = null
  private quitting = false
  private retry = 0
  private port: number | null = null
  private state: SidecarState = 'stopped'
  private message: string | undefined
  private stdoutBuf = ''
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private exitWaiters: Array<() => void> = []

  constructor(options: PythonManagerOptions) {
    super()
    this.opts = {
      spawn: nodeSpawn as unknown as SpawnFn,
      logger: noopLogger,
      retryDelaysMs: [1000, 2000, 4000],
      startupTimeoutMs: 20_000,
      stableAfterMs: 30_000,
      killGraceMs: 3000,
      prefixArgs: ['-m', 'app.main'],
      extraEnv: {},
      platform: process.platform,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      ...options
    }
  }

  getPid(): number | null {
    return this.child?.pid ?? null
  }

  getStatus(): SidecarStatus {
    const s: SidecarStatus = { state: this.state, port: this.port, retry: this.retry }
    if (this.message) s.message = this.message
    return s
  }

  start(): void {
    this.quitting = false
    this.spawnChild('starting')
  }

  /** Stop the sidecar for good (app quit). Resolves once the child is gone. */
  stop(): Promise<void> {
    this.quitting = true
    this.clearAllTimers()
    const child = this.child
    if (!child) {
      this.port = null
      this.setState('stopped')
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve)
      this.killChild(child, 'SIGTERM')
      this.killTimer = this.opts.setTimeoutFn(() => {
        this.opts.logger.warn('sidecar did not exit after SIGTERM, forcing kill')
        this.killChild(child, 'SIGKILL', true)
      }, this.opts.killGraceMs)
    })
  }

  private killChild(child: ChildProcess, signal: NodeJS.Signals, force = false): void {
    try {
      if (this.opts.platform === 'win32' && child.pid) {
        if (this.opts.killTree) this.opts.killTree(child.pid)
        else nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill(force ? 'SIGKILL' : signal)
      }
    } catch (err) {
      this.opts.logger.error('failed to kill sidecar', err)
    }
  }

  private spawnChild(initialState: SidecarState): void {
    const { pythonExe, backendDir, dataDir } = this.opts
    this.stdoutBuf = ''
    this.port = null
    this.message = undefined
    this.setState(initialState)
    const args = [
      ...this.opts.prefixArgs,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      dataDir
    ]
    this.opts.logger.info('spawning sidecar', pythonExe, args.join(' '))
    let child: ChildProcess
    try {
      child = this.opts.spawn(pythonExe, args, {
        cwd: backendDir,
        windowsHide: true,
        // MIZAJ_PARENT_PID lets the sidecar exit by itself if Electron dies without will-quit.
        env: {
          ...process.env,
          ...this.opts.extraEnv,
          PYTHONUNBUFFERED: '1',
          MIZAJ_PARENT_PID: String(process.pid),
          // Same token for every (re)start within one app launch.
          ...(this.opts.apiToken ? { MIZAJ_API_TOKEN: this.opts.apiToken } : {})
        }
      })
    } catch (err) {
      this.opts.logger.error('spawn threw', err)
      this.handleExit(null, null, String(err))
      return
    }
    this.child = child
    if (child.pid) this.opts.logger.info(`sidecar started pid=${child.pid}`)
    let handled = false
    const once = (code: number | null, signal: NodeJS.Signals | null, msg?: string): void => {
      if (handled) return
      handled = true
      if (this.child === child) this.child = null
      this.handleExit(code, signal, msg)
    }
    child.stdout?.on('data', (d: Buffer | string) => this.onStdout(String(d)))
    child.stderr?.on('data', (d: Buffer | string) => this.logLines(String(d), 'warn'))
    child.on('error', (err: Error) => once(null, null, err.message))
    child.on('exit', (code, signal) => once(code, signal))

    this.startupTimer = this.opts.setTimeoutFn(() => {
      this.opts.logger.error('sidecar startup timeout')
      this.message = 'startup timeout'
      this.killChild(child, 'SIGKILL', true)
    }, this.opts.startupTimeoutMs)
  }

  private logLines(chunk: string, level: 'info' | 'warn'): void {
    for (const line of chunk.split(/\r?\n/)) if (line) this.opts.logger[level]('[sidecar]', line)
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    const lines = this.stdoutBuf.split(/\r?\n/)
    this.stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      this.opts.logger.info('[sidecar]', line)
      const pm = /MIZAJ_PORT=(\d+)/.exec(line)
      if (pm) this.port = Number(pm[1])
      if (/MIZAJ_STATUS=READY/.test(line) && this.port !== null) this.onReady()
    }
  }

  private onReady(): void {
    if (this.state === 'ready') return
    this.clearTimer('startupTimer')
    this.message = undefined
    this.setState('ready')
    this.clearTimer('stableTimer')
    this.stableTimer = this.opts.setTimeoutFn(() => {
      this.stableTimer = null
      if (this.retry !== 0) {
        this.retry = 0
        this.emitStatus()
      }
    }, this.opts.stableAfterMs)
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, msg?: string): void {
    this.clearTimer('startupTimer')
    this.clearTimer('stableTimer')
    this.clearTimer('killTimer')
    this.port = null
    this.opts.logger.warn(`sidecar exited code=${code} signal=${signal}${msg ? ' ' + msg : ''}`)
    const waiters = this.exitWaiters
    this.exitWaiters = []
    if (this.quitting) {
      this.setState('stopped')
      waiters.forEach((w) => w())
      return
    }
    if (code === 0 && !signal && !msg) {
      this.setState('stopped')
      return
    }
    const delays = this.opts.retryDelaysMs
    if (this.retry >= delays.length) {
      this.message = msg ?? `exited code=${code} signal=${signal}`
      this.setState('crashed')
      return
    }
    const delay = delays[this.retry]
    this.retry += 1
    this.message = msg
    this.setState('restarting')
    this.restartTimer = this.opts.setTimeoutFn(() => {
      this.restartTimer = null
      if (!this.quitting) this.spawnChild('restarting')
    }, delay)
  }

  private clearTimer(name: 'startupTimer' | 'stableTimer' | 'restartTimer' | 'killTimer'): void {
    const t = this[name]
    if (t) this.opts.clearTimeoutFn(t)
    this[name] = null
  }

  private clearAllTimers(): void {
    this.clearTimer('startupTimer')
    this.clearTimer('stableTimer')
    this.clearTimer('restartTimer')
  }

  private setState(state: SidecarState): void {
    this.state = state
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit(STATUS_EVENT, this.getStatus())
  }
}
