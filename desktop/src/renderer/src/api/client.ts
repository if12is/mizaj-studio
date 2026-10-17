import { getApiToken, refreshConfig, waitForConfig, withToken } from './token'

export interface ErrorEnvelope {
  error_code: string
  message_ar: string
  message_en: string
  details: Record<string, unknown>
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string,
    public readonly messageAr: string,
    public readonly messageEn: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(messageEn || messageAr || errorCode)
    this.name = 'ApiError'
  }
}

function isEnvelope(v: unknown): v is ErrorEnvelope {
  return !!v && typeof v === 'object' && typeof (v as ErrorEnvelope).error_code === 'string'
}

/** Turn a non-2xx Response into an ApiError, tolerating non-envelope bodies. */
export async function parseError(res: Response): Promise<ApiError> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (isEnvelope(body)) {
    return new ApiError(
      res.status,
      body.error_code,
      body.message_ar || 'حدث خطأ غير متوقع.',
      body.message_en || '',
      body.details ?? {}
    )
  }
  return new ApiError(
    res.status,
    'ERR_UNKNOWN',
    'حدث خطأ غير متوقع في الاتصال بالمحرك الخلفي.',
    `HTTP ${res.status}`
  )
}

export interface ApiClientOptions {
  getBaseUrl: () => string | null
  fetchImpl?: typeof fetch
  onError?: (e: ApiError) => void
  /** token source; defaults to the shared per-launch token */
  getToken?: () => string | null
}

export class ApiClient {
  constructor(private readonly o: ApiClientOptions) {}

  async request<T>(method: string, path: string, body?: unknown, silent = false): Promise<T> {
    await waitForConfig()
    let base = this.o.getBaseUrl()
    if (!base) {
      const err = new ApiError(
        0,
        'ERR_BACKEND_UNAVAILABLE',
        'المحرك الخلفي غير جاهز بعد.',
        'Backend is not ready'
      )
      if (!silent) this.o.onError?.(err)
      throw err
    }
    const f = this.o.fetchImpl ?? fetch
    const send = (b: string): Promise<Response> =>
      f(b + path, {
        method,
        headers: withToken(
          body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          (this.o.getToken ?? getApiToken)()
        ),
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
    let res: Response
    try {
      res = await send(base)
      if (res.status === 401) {
        // stale/missed token: re-read the config from main once and retry
        await refreshConfig()
        base = this.o.getBaseUrl() ?? base
        res = await send(base)
      }
    } catch (e) {
      const err = new ApiError(
        0,
        'ERR_NETWORK',
        'تعذر الاتصال بالمحرك الخلفي.',
        e instanceof Error ? e.message : 'network error'
      )
      if (!silent) this.o.onError?.(err)
      throw err
    }
    if (!res.ok) {
      const err = await parseError(res)
      if (!silent) this.o.onError?.(err)
      throw err
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  get = <T>(path: string, silent = false): Promise<T> =>
    this.request<T>('GET', path, undefined, silent)
  post = <T>(path: string, body?: unknown): Promise<T> => this.request<T>('POST', path, body ?? {})
  put = <T>(path: string, body: unknown, silent = false): Promise<T> =>
    this.request<T>('PUT', path, body, silent)
  del = (path: string): Promise<void> => this.request<void>('DELETE', path)
}

export interface Project {
  id: number
  name: string
  description: string
  created_at: string
  updated_at: string
}
export interface DocumentSummary {
  id: number
  project_id: number
  title: string
  language: string
  direction: string
  word_count: number
  updated_at: string
}
export interface DocumentFull extends DocumentSummary {
  source_docx_path: string | null
  raw_content: string
  diacritized_content: string | null
}
export interface DictEntry {
  id: number
  word_or_phrase: string
  diacritized_form: string
  source: string
  is_user_locked: number
  usage_count: number
}
export type SettingsMap = Record<string, string>
