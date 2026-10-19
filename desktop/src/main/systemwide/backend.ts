import type { PipelineDeps, ProofreadItem } from './pipeline'

/**
 * Backend calls for the pipelines, made from the MAIN process over loopback with the per-launch
 * token (the same API the renderer uses; nothing leaves the device). The text goes only in the
 * request body, never in a URL, and is never logged.
 */
export interface BackendTarget {
  baseUrl: string | null
  token: string
}

export class BackendError extends Error {
  constructor(
    public readonly code: string,
    public readonly messageAr: string
  ) {
    super(code)
    this.name = 'BackendError'
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export const REQUEST_TIMEOUT_MS = 180_000

export function createBackendDeps(
  getTarget: () => BackendTarget,
  fetchImpl: FetchLike = (u, i) => fetch(u, i)
): PipelineDeps {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const t = getTarget()
    if (!t.baseUrl)
      throw new BackendError(
        'ERR_BACKEND_UNAVAILABLE',
        'المحرك الخلفي غير جاهز بعد. انتظر لحظة وأعد المحاولة.'
      )
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetchImpl(t.baseUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Mizaj-Token': t.token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal
      })
      if (!res.ok) {
        let code = 'ERR_UNKNOWN'
        let ar = 'حدث خطأ غير متوقع في المحرك الخلفي.'
        try {
          const j = (await res.json()) as { error_code?: string; message_ar?: string }
          if (typeof j.error_code === 'string') code = j.error_code
          if (typeof j.message_ar === 'string' && j.message_ar) ar = j.message_ar
        } catch {
          /* keep generic */
        }
        throw new BackendError(code, ar)
      }
      return (await res.json()) as T
    } catch (e) {
      if (e instanceof BackendError) throw e
      if ((e as { name?: string }).name === 'AbortError')
        throw new BackendError('ERR_TIMEOUT', 'استغرقت المعالجة وقتاً طويلاً وأُوقفت.')
      throw new BackendError('ERR_BACKEND_UNAVAILABLE', 'تعذّر الاتصال بالمحرك الخلفي.')
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async proofread(text, categories) {
      const r = await call<{ items?: ProofreadItem[] }>('POST', '/api/proofread', {
        text,
        categories: [...categories],
        max_items: 20000
      })
      return { items: Array.isArray(r.items) ? r.items : [] }
    },
    async apply(text, items) {
      const r = await call<{ text: string; applied: number; skipped?: unknown[] }>(
        'POST',
        '/api/proofread/apply',
        {
          text,
          items: items.map((i) => ({
            start: i.start,
            end: i.end,
            original: i.original,
            replacement: i.replacement
          }))
        }
      )
      return { text: r.text, applied: r.applied, skipped: r.skipped?.length ?? 0 }
    },
    async tashkeel(text) {
      // the user's default engine and level (Settings), exactly as the editor would use them
      const s = await call<Record<string, string>>('GET', '/api/settings')
      const mode = s.engine_mode === 'accurate' ? 'accurate' : 'fast'
      const levels = ['full', 'irab_only', 'essential', 'minimal', 'legal']
      const level = levels.includes(s.tashkeel_level) ? s.tashkeel_level : 'full'
      const r = await call<{ text: string }>('POST', '/api/tashkeel', {
        text,
        mode,
        level,
        keep_existing: true,
        protect_quran: true
      })
      return { text: r.text }
    }
  }
}
