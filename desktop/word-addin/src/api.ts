import type { TextEdit } from '../../src/main/systemwide/textDiff'
import type { PreviewSegment } from '../../src/main/systemwide/textDiff'

/** Client of the Mizaj main process (https://localhost:<port>/wa/*). Never logs or stores text. */

export type OpId = 'proofread' | 'punctuation' | 'tashkeel' | 'all'

export type ApiErrorCode =
  | 'app_down'
  | 'not_paired'
  | 'busy'
  | 'rate_limited'
  | 'backend'
  | 'rejected'
  | 'bad_response'

export const APP_DOWN_AR = 'افتح برنامج مِزَاج أولاً'

export class AddinApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    public readonly messageAr: string
  ) {
    super(code)
    this.name = 'AddinApiError'
  }
}

export interface ProcessResponse {
  ok: true
  changed: boolean
  edits: TextEdit[][]
  segments: PreviewSegment[]
  warnings: string[]
  applied: { proofread: number; punctuation: number }
  tashkeelRan: boolean
}

export interface Api {
  ping(): Promise<{ engine: boolean }>
  process(op: OpId, paragraphs: string[]): Promise<ProcessResponse>
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export function createApi(opts: {
  origin: string
  token: string | null
  fetchImpl?: FetchLike
}): Api {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  async function call<T>(path: string, body: unknown): Promise<T> {
    if (!opts.token)
      throw new AddinApiError(
        'not_paired',
        'الإضافة غير مقترنة بمِزَاج. أعد تثبيتها من «الإعدادات» ← «إعدادات متقدمة» ← «إضافة Word».'
      )
    let res: Response
    try {
      res = await doFetch(opts.origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Mizaj-Pair': opts.token },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      })
    } catch {
      throw new AddinApiError('app_down', APP_DOWN_AR)
    }
    let json: Record<string, unknown> | null = null
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      json = null
    }
    if (res.ok && json && json.ok === true) return json as T
    const msg = typeof json?.message_ar === 'string' ? json.message_ar : ''
    const code = typeof json?.code === 'string' ? json.code : ''
    if (res.status === 403 && (code === 'bad_pair' || code === 'not_paired'))
      throw new AddinApiError(
        'not_paired',
        'رمز الاقتران لم يعد صالحاً. أعد تثبيت الإضافة من إعدادات مِزَاج.'
      )
    if (res.status === 429)
      throw new AddinApiError(
        code === 'rate_limited' ? 'rate_limited' : 'busy',
        msg || 'المعالجة السابقة لم تنتهِ بعد. انتظر لحظة.'
      )
    if (res.status === 503) throw new AddinApiError('backend', msg || 'محرك مِزَاج غير جاهز بعد.')
    if (res.status >= 400 && res.status < 500 && msg) throw new AddinApiError('rejected', msg)
    throw new AddinApiError('bad_response', msg || 'ردّ غير متوقع من مِزَاج.')
  }
  return {
    async ping() {
      const r = await call<{ engine?: boolean }>('/wa/ping', {})
      return { engine: r.engine === true }
    },
    async process(op, paragraphs) {
      const r = await call<ProcessResponse>('/wa/process', { op, paragraphs })
      if (!Array.isArray(r.edits) || r.edits.length !== paragraphs.length)
        throw new AddinApiError('bad_response', 'ردّ غير متوقع من مِزَاج.')
      return r
    }
  }
}
