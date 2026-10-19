import { createCache, type Content, type CreatedCache, type FetchLike } from './api'
import { GeminiError } from './errors'
import type { CacheRef, ChatSession } from './sessions'

/** Documents at least this long (chars) get an explicit cache; shorter ones rely on implicit caching. */
export const CACHE_MIN_CHARS = 30_000

/**
 * Models where cachedContents proved unsupported (400/403/404, or quota on create = free tier)
 * are remembered for the process so we do not retry on every question.
 */
export class CacheSupport {
  private bad = new Set<string>()
  ok(model: string): boolean {
    return !this.bad.has(model)
  }
  markUnsupported(model: string): void {
    this.bad.add(model)
  }
}

/** The cache is still usable: same model, not past its (client-side) expiry. */
export function cacheValid(c: CacheRef | null, model: string, now: number): c is CacheRef {
  return !!c && c.model === model && c.expiresAt > now
}

/** HTTP statuses meaning "the cached content is gone": recreate (or fall back). */
export function isCacheGone(e: unknown): boolean {
  return e instanceof GeminiError && (e.status === 404 || e.status === 403)
}

export interface EnsureArgs {
  f: FetchLike
  base: string
  key: string
  model: string
  system: string
  prefix: Content[]
  docChars: number
  session: ChatSession
  support: CacheSupport
  now?: () => number
  /** ignore the current cache (e.g. after a 404) and create a new one */
  force?: boolean
}

/**
 * Returns the cache name to use for this turn, creating one when needed, or null to fall back to
 * sending the document inline (small doc, unsupported model/free tier, or any create failure).
 * Mutates session.cache.
 */
export async function ensureCache(a: EnsureArgs): Promise<string | null> {
  const now = (a.now ?? Date.now)()
  if (a.docChars < CACHE_MIN_CHARS || !a.support.ok(a.model)) return null
  if (!a.force && cacheValid(a.session.cache, a.model, now)) return a.session.cache.name
  a.session.cache = null
  try {
    const c: CreatedCache = await createCache(
      a.f,
      a.base,
      a.key,
      a.model,
      a.system,
      a.prefix,
      a.now ?? Date.now
    )
    a.session.cache = { name: c.name, model: a.model, expiresAt: c.expiresAt }
    return c.name
  } catch (e) {
    if (
      e instanceof GeminiError &&
      (e.status === 400 || e.status === 403 || e.status === 404 || e.code === 'quota')
    )
      a.support.markUnsupported(a.model)
    return null
  }
}

/** Best-effort removal of the remote cache (new conversation / document changed). */
export async function deleteRemoteCache(
  f: FetchLike,
  base: string,
  key: string,
  name: string
): Promise<void> {
  if (!/^cachedContents\/[A-Za-z0-9_-]{1,128}$/.test(name)) return
  try {
    await f(`${base}/v1beta/${name}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': key },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
  } catch {
    /* the cache expires by itself */
  }
}
