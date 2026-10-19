import { timingSafeEqual } from 'node:crypto'

/**
 * Request validation for the Word add-in server (pure, no I/O). The add-in is a web page running
 * inside Word, so the server treats every request as coming from a browser context:
 *
 *  - Host must be localhost / 127.0.0.1 on OUR port (DNS-rebinding defence);
 *  - the API accepts only `Origin: https://localhost:<port>` (exactly our own page) and refuses
 *    `Sec-Fetch-Site` values other than same-origin; no CORS headers are ever sent;
 *  - the API needs the per-install pairing token (header `X-Mizaj-Pair`); the HTML pages need it
 *    as `?k=` (it is part of the SourceLocation URL written into the manifest at install time);
 *  - the general backend token (`X-Mizaj-Token`) is never given to Word: the main process calls the
 *    backend itself.
 * A same-user local process can read the manifest and therefore the pairing token; this is
 * documented. The token and the text are never logged.
 */

export const PAIR_HEADER = 'x-mizaj-pair'
export const PAIR_TOKEN_BYTES = 32
export const MAX_BODY_BYTES = 2_000_000

export interface GuardConfig {
  port: number
  /** 'https' in production; tests may use 'http' */
  scheme: 'https' | 'http'
  /** current pairing token, null when the add-in is not installed */
  token: string | null
}

export interface RequestLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
}

export type GuardResult = { ok: true } | { ok: false; status: number; code: GuardCode }
export type GuardCode =
  | 'bad_host'
  | 'bad_origin'
  | 'cross_site'
  | 'not_paired'
  | 'bad_pair'
  | 'bad_method'
  | 'bad_content_type'

const first = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? v[0] ?? '' : v ?? ''

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

export function expectedOrigin(c: Pick<GuardConfig, 'port' | 'scheme'>): string {
  return `${c.scheme}://localhost:${c.port}`
}

export function hostAllowed(host: string, c: Pick<GuardConfig, 'port'>): boolean {
  const h = host.toLowerCase()
  return h === `localhost:${c.port}` || h === `127.0.0.1:${c.port}` || h === `[::1]:${c.port}`
}

/** Static files and the health route: only the Host check (they contain no secret). */
export function checkStatic(req: RequestLike, c: GuardConfig): GuardResult {
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return { ok: false, status: 405, code: 'bad_method' }
  if (!hostAllowed(first(req.headers.host), c)) return { ok: false, status: 403, code: 'bad_host' }
  return { ok: true }
}

/** HTML pages: Host + pairing token in the URL + not requested cross-site. */
export function checkPage(
  req: RequestLike,
  c: GuardConfig,
  queryToken: string | null
): GuardResult {
  const r = checkStatic(req, c)
  if (!r.ok) return r
  const site = first(req.headers['sec-fetch-site'])
  if (site === 'cross-site') return { ok: false, status: 403, code: 'cross_site' }
  if (!c.token) return { ok: false, status: 403, code: 'not_paired' }
  if (!queryToken || !safeEqual(queryToken, c.token))
    return { ok: false, status: 403, code: 'bad_pair' }
  return { ok: true }
}

/** The JSON API: POST only, exact Origin, same-origin fetch, JSON body, pairing header. */
export function checkApi(req: RequestLike, c: GuardConfig): GuardResult {
  if (req.method !== 'POST') return { ok: false, status: 405, code: 'bad_method' }
  if (!hostAllowed(first(req.headers.host), c)) return { ok: false, status: 403, code: 'bad_host' }
  if (first(req.headers.origin) !== expectedOrigin(c))
    return { ok: false, status: 403, code: 'bad_origin' }
  const site = first(req.headers['sec-fetch-site'])
  if (site && site !== 'same-origin') return { ok: false, status: 403, code: 'cross_site' }
  if (!/^application\/json\b/i.test(first(req.headers['content-type'])))
    return { ok: false, status: 415, code: 'bad_content_type' }
  if (!c.token) return { ok: false, status: 403, code: 'not_paired' }
  const given = first(req.headers[PAIR_HEADER])
  if (!given || !safeEqual(given, c.token)) return { ok: false, status: 403, code: 'bad_pair' }
  return { ok: true }
}

/** Sliding-window limiter: at most `max` calls per `windowMs`. */
export class RateLimiter {
  private hits: number[] = []
  constructor(
    private readonly max = 60,
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now
  ) {}
  allow(): boolean {
    const t = this.now()
    this.hits = this.hits.filter((h) => t - h < this.windowMs)
    if (this.hits.length >= this.max) return false
    this.hits.push(t)
    return true
  }
}
