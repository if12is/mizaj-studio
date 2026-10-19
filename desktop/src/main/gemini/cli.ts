import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { GeminiError } from './errors'

/**
 * Gemini CLI integration. The user's own installed CLI (their account, their limits) is run
 * non-interactively. NO user text ever goes into argv: the arguments are a fixed ASCII string and the
 * whole prompt (instructions + document excerpt) is written to STDIN. spawn is always used with an
 * argument array and shell:false.
 */

export const CLI_FIXED_PROMPT = 'Answer the request given on stdin.'
export const DETECT_TIMEOUT_MS = 10_000
export const ASK_TIMEOUT_MS = 90_000
export const MAX_OUTPUT_BYTES = 256 * 1024

export interface CliStatus {
  detected: boolean
  version: string | null
  path: string | null
}

export interface Launch {
  command: string
  args: string[]
  env?: Record<string, string>
  windowsVerbatimArguments?: boolean
}

export interface CliDeps {
  spawn: typeof nodeSpawn
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  /** path of the running Electron/Node binary (used to run npm's JS entry directly on Windows) */
  execPath: string
}

export function defaultDeps(): CliDeps {
  return {
    spawn: nodeSpawn,
    env: process.env,
    platform: process.platform,
    execPath: process.execPath
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** First `gemini` (Windows: gemini.cmd / gemini.exe) found on PATH. */
export function findOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const pathVar = env.PATH ?? env.Path ?? ''
  const names = platform === 'win32' ? ['gemini.cmd', 'gemini.exe'] : ['gemini']
  for (const dir of pathVar.split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue
    for (const n of names) {
      const p = join(dir.replace(/^"|"$/g, ''), n)
      if (isFile(p)) return p
    }
  }
  return null
}

/** characters that could break out of a cmd.exe command line */
const UNSAFE_CMD_PATH = /["&|<>^%!\r\n\0]/

/**
 * How to start the CLI without a shell. On Windows an npm `.cmd` shim is replaced by running its
 * JS entry with the Electron binary in node mode; only if that is not found do we use
 * `cmd /d /s /c` with a strictly validated path and fixed arguments.
 */
export function resolveLaunch(bin: string, extra: string[], d: CliDeps): Launch {
  const args = ['-p', CLI_FIXED_PROMPT, ...extra]
  if (d.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { command: bin, args }
  const base = dirname(bin)
  const candidates = [
    join(base, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js'),
    join(base, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js')
  ]
  const script = candidates.find((c) => existsSync(c))
  if (script) {
    return {
      command: d.execPath,
      args: [script, ...args],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
  }
  if (UNSAFE_CMD_PATH.test(bin)) throw new GeminiError('cli_failed')
  return {
    command: d.env.ComSpec || 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      `"${bin}" ${args.map((a) => (/^[\w.-]+$/.test(a) ? a : `"${a}"`)).join(' ')}`
    ],
    windowsVerbatimArguments: true
  }
}

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  truncated: boolean
}

function childEnv(d: CliDeps, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...d.env, ...extra, NO_COLOR: '1' }
  delete env.MIZAJ_API_TOKEN
  return env
}

/** On Windows, killing a `cmd /c` wrapper leaves its child running: kill the whole tree. */
function stop(child: { pid?: number; kill: () => boolean }, d: CliDeps): void {
  if (d.platform === 'win32' && child.pid) {
    try {
      d.spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      })
      return
    } catch {
      /* fall back to a plain kill */
    }
  }
  child.kill()
}

function run(l: Launch, d: CliDeps, stdin: string | null, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const opts: SpawnOptions = {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: l.windowsVerbatimArguments,
      env: childEnv(d, l.env),
      stdio: ['pipe', 'pipe', 'pipe']
    }
    let child
    try {
      child = d.spawn(l.command, l.args, opts)
    } catch {
      reject(new GeminiError('cli_missing'))
      return
    }
    // Collect raw bytes and decode once: a multi-byte UTF-8 character may be split across chunks.
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let truncated = false
    let done = false
    const finish = (r: RunResult | Error): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (r instanceof Error) reject(r)
      else resolve(r)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop(child, d)
    }, timeoutMs)
    child.stdout?.on('data', (b: Buffer | string) => {
      const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b
      if (outBytes + buf.length > MAX_OUTPUT_BYTES) {
        truncated = true
        outChunks.push(buf.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - outBytes)))
        outBytes = MAX_OUTPUT_BYTES
        stop(child, d)
      } else {
        outChunks.push(buf)
        outBytes += buf.length
      }
    })
    child.stderr?.on('data', (b: Buffer | string) => {
      if (errBytes < 8192) {
        const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b
        errChunks.push(buf)
        errBytes += buf.length
      }
    })
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(new GeminiError(e.code === 'ENOENT' ? 'cli_missing' : 'cli_failed'))
    )
    child.on('close', (code) =>
      finish({
        stdout: new TextDecoder('utf-8').decode(Buffer.concat(outChunks)),
        stderr: new TextDecoder('utf-8').decode(Buffer.concat(errChunks)),
        code,
        timedOut,
        truncated
      })
    )
    child.stdin?.on('error', () => undefined) // CLI may exit before reading stdin
    if (stdin !== null) child.stdin?.end(stdin, 'utf8')
    else child.stdin?.end()
  })
}

/** `gemini --version` on the PATH-resolved binary. Never throws. */
export async function detectCli(d: CliDeps = defaultDeps()): Promise<CliStatus> {
  const bin = findOnPath(d.env, d.platform)
  if (!bin) return { detected: false, version: null, path: null }
  try {
    const l = resolveLaunch(bin, [], d)
    // `--version` instead of -p: build args by hand
    const r = await run(
      {
        ...l,
        args: l.args.filter((a) => a !== '-p' && a !== CLI_FIXED_PROMPT).concat('--version')
      },
      d,
      null,
      DETECT_TIMEOUT_MS
    )
    const m = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(r.stdout + r.stderr)
    if (r.code === 0 && m) return { detected: true, version: m[0], path: bin }
  } catch {
    /* not usable */
  }
  return { detected: false, version: null, path: bin }
}

export function classifyFailure(stderr: string, stdout: string): GeminiError {
  const t = `${stderr}\n${stdout}`
  if (
    /(not (logged|signed) in|log ?in|sign ?in|authenticat|credential|oauth|api key|GEMINI_API_KEY|unauthorized|401|403)/i.test(
      t
    )
  )
    return new GeminiError('cli_login')
  if (/(quota|429|RESOURCE_EXHAUSTED|rate limit)/i.test(t)) return new GeminiError('quota')
  if (/(ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network|fetch failed)/i.test(t))
    return new GeminiError('offline')
  return new GeminiError('cli_failed')
}

/** Ask the installed CLI; `input` (instructions + excerpt) goes through stdin only. */
export async function askCli(input: string, d: CliDeps = defaultDeps()): Promise<string> {
  const bin = findOnPath(d.env, d.platform)
  if (!bin) throw new GeminiError('cli_missing')
  const r = await run(resolveLaunch(bin, [], d), d, input, ASK_TIMEOUT_MS)
  if (r.timedOut) throw new GeminiError('cli_timeout')
  const out = r.stdout.trim()
  if (r.code !== 0 && !(r.truncated && out)) throw classifyFailure(r.stderr, r.stdout)
  if (!out) throw classifyFailure(r.stderr, '') // exit 0 but nothing: often "not logged in"
  return out
}
