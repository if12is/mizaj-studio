import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'

/**
 * Pure (Electron-free) security helpers: token, CSP, URL/sender checks, path allowlist.
 * Everything here is unit-tested; the Electron wiring lives in hardening.ts / ipcGuard.ts.
 */

// ---------------------------------------------------------------- API token (8.1.1)

export const TOKEN_HEADER = 'X-Mizaj-Token'

/** 32 random bytes -> 64 hex chars. One per app launch, reused across sidecar restarts. */
export function generateApiToken(bytes: (n: number) => Buffer = randomBytes): string {
  return bytes(32).toString('hex')
}

// ---------------------------------------------------------------- secret scrubbing (8.2.4)

const REDACTED = '<redacted>'

/** Remove known secrets and anything shaped like a token/header from a log string. */
export function scrubSecrets(
  text: string,
  secrets: readonly string[] = [],
  anyHex = false
): string {
  let s = text
  for (const sec of secrets) if (sec && sec.length >= 8) s = s.split(sec).join(REDACTED)
  return s
    .replace(/(X-Mizaj-Token["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, `$1${REDACTED}`)
    .replace(/(MIZAJ_API_TOKEN["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, `$1${REDACTED}`)
    .replace(anyHex ? /\b[0-9a-f]{64}\b/gi : /(?!)/g, REDACTED)
}

// ---------------------------------------------------------------- CSP (8.2.1)

/** Production CSP. 'unsafe-inline' for styles only: CodeMirror (style-mod) injects <style> tags at runtime. */
export function buildCsp(opts: { dev?: boolean } = {}): string {
  const connect = ["'self'", 'http://127.0.0.1:*']
  if (opts.dev) connect.push('ws://localhost:*', 'http://localhost:*')
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'"
  ].join('; ')
}

// ---------------------------------------------------------------- app URL / sender checks

export interface AppLocation {
  /** Dev server URL (ELECTRON_RENDERER_URL) or null when serving from disk. */
  rendererUrl: string | null
  /** Absolute path of the built renderer index.html. */
  indexHtmlPath: string
  platform?: NodeJS.Platform
}

/** True if `raw` is the app's own page (exact index.html, or the dev server origin). Hash/query are ignored. */
export function isAppUrl(raw: unknown, loc: AppLocation): boolean {
  if (typeof raw !== 'string' || !raw) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (loc.rendererUrl) {
    try {
      return u.origin !== 'null' && u.origin === new URL(loc.rendererUrl).origin
    } catch {
      return false
    }
  }
  if (u.protocol !== 'file:' || u.host) return false
  const want = pathToFileURL(loc.indexHtmlPath).pathname
  const norm = (p: string): string =>
    (loc.platform ?? process.platform) === 'win32' ? decodeURI(p).toLowerCase() : decodeURI(p)
  return norm(u.pathname) === norm(want)
}

// ---------------------------------------------------------------- openExternal allowlist (8.2.2)

export const EXTERNAL_HOST_ALLOWLIST = [
  'tanzil.net',
  'github.com',
  'microsoft.com', // learn.microsoft.com, support.microsoft.com, ...
  'tesseract-ocr.github.io',
  'ollama.com',
  'languagetool.org',
  'creativecommons.org',
  'sourceforge.net' // license links in the resource catalog
] as const

export const MAX_URL_LENGTH = 2048

/** https:// only, no credentials, host (or parent domain) on the allowlist. */
export function isAllowedExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return false
  if (u.port && u.port !== '443') return false
  const host = u.hostname.toLowerCase()
  return EXTERNAL_HOST_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`))
}

// ---------------------------------------------------------------- dialog path allowlist (8.2.2)

/** Paths the user picked in a native dialog; only these may be handed to shell.openPath. */
export class PathAllowlist {
  private readonly items = new Map<string, number>()
  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly max = 64,
    private readonly now: () => number = Date.now,
    private readonly caseInsensitive = process.platform === 'win32'
  ) {}

  private key(p: string): string {
    return this.caseInsensitive ? p.toLowerCase() : p
  }

  add(p: unknown): void {
    if (typeof p !== 'string' || !p) return
    this.prune()
    this.items.delete(this.key(p))
    this.items.set(this.key(p), this.now() + this.ttlMs)
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value as string
      this.items.delete(oldest)
    }
  }

  has(p: unknown): boolean {
    if (typeof p !== 'string' || !p) return false
    this.prune()
    return this.items.has(this.key(p))
  }

  private prune(): void {
    const t = this.now()
    for (const [k, exp] of this.items) if (exp <= t) this.items.delete(k)
  }
}

// ---------------------------------------------------------------- argument validation

export const MAX_PATH_LENGTH = 4096
export const MAX_NAME_LENGTH = 255

export function isBoundedString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max && !v.includes('\0')
}
