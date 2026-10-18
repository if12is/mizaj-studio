import { GeminiError } from './errors'

export const DEFAULT_BASE = 'https://generativelanguage.googleapis.com'
export const ALLOWED_HOST = 'generativelanguage.googleapis.com'
export const LIST_TIMEOUT_MS = 20_000
export const ASK_TIMEOUT_MS = 60_000
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** Offline fallback only (documented moving aliases); the live list replaces it. */
export const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-pro-latest']

export interface ModelInfo {
  id: string
  display: string
}

/**
 * Base URL. The override exists ONLY for tests and is honoured only when `allowOverride`
 * (= !app.isPackaged); it must still be a loopback http(s) URL.
 */
export function resolveBase(env: NodeJS.ProcessEnv, allowOverride: boolean): string {
  const o = env.MIZAJ_GEMINI_BASE_URL
  if (!allowOverride || !o) return DEFAULT_BASE
  try {
    const u = new URL(o)
    const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && loop) return u.origin
  } catch {
    /* ignore */
  }
  return DEFAULT_BASE
}

/** Only https://generativelanguage.googleapis.com (or the test override base) may be contacted. */
export function assertAllowedUrl(url: string, base: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new GeminiError('bad_request')
  }
  if (base !== DEFAULT_BASE) {
    if (u.origin !== base) throw new GeminiError('bad_request')
    return
  }
  if (
    u.protocol !== 'https:' ||
    u.hostname !== ALLOWED_HOST ||
    u.username ||
    u.password ||
    (u.port && u.port !== '443')
  )
    throw new GeminiError('bad_request')
}

export function isValidModelId(m: unknown): m is string {
  return typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(m)
}

function version(id: string): number {
  const m = /gemini-(\d+(?:\.\d+)?)/.exec(id)
  if (m) return parseFloat(m[1])
  return /latest/.test(id) ? 999 : 0 // moving aliases track the newest
}

const NOT_TEXT = /(embedding|aqa|imagen|veo|-tts|image|live|native-audio|robotics|computer-use)/i

/** Newest first: higher version, then stable before preview, then name. */
export function sortModels(list: ModelInfo[]): ModelInfo[] {
  const preview = (id: string): number => (/(preview|exp)/.test(id) ? 1 : 0)
  return [...list].sort(
    (a, b) =>
      version(b.id) - version(a.id) || preview(a.id) - preview(b.id) || a.id.localeCompare(b.id)
  )
}

/** Fast default = newest "flash" (non-lite preferred), else the first model. */
export function pickDefaultModel(models: ModelInfo[]): string {
  const flash = models.filter((m) => /flash/i.test(m.id))
  return (
    flash.find((m) => !/lite/i.test(m.id))?.id ??
    flash[0]?.id ??
    models[0]?.id ??
    FALLBACK_MODELS[0]
  )
}

export function parseModels(json: unknown): ModelInfo[] {
  const arr = (json as { models?: unknown })?.models
  if (!Array.isArray(arr)) throw new GeminiError('bad_response')
  const out: ModelInfo[] = []
  for (const m of arr) {
    const r = m as {
      name?: unknown
      displayName?: unknown
      supportedGenerationMethods?: unknown
    }
    if (typeof r.name !== 'string') continue
    const methods = Array.isArray(r.supportedGenerationMethods) ? r.supportedGenerationMethods : []
    if (!methods.includes('generateContent')) continue
    const id = r.name.replace(/^models\//, '')
    if (!isValidModelId(id) || NOT_TEXT.test(id)) continue
    out.push({ id, display: typeof r.displayName === 'string' ? r.displayName : id })
  }
  return sortModels(out)
}

export type FetchLike = typeof fetch

async function request(
  f: FetchLike,
  base: string,
  path: string,
  key: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  timeoutMs: number
): Promise<unknown> {
  const url = `${base}${path}`
  assertAllowedUrl(url, base)
  let res: Response
  try {
    res = await f(url, {
      method: init.method,
      headers: {
        'x-goog-api-key': key,
        ...(init.body ? { 'content-type': 'application/json' } : {})
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'TimeoutError' || name === 'AbortError') throw new GeminiError('timeout')
    throw new GeminiError('offline')
  }
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_BODY_BYTES) throw new GeminiError('bad_response')
  let text = ''
  try {
    text = (await res.text()).slice(0, MAX_BODY_BYTES)
  } catch {
    throw new GeminiError('offline')
  }
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  if (!res.ok) throw httpError(res.status, json)
  if (json === null) throw new GeminiError('bad_response')
  return json
}

export function httpError(status: number, json: unknown): GeminiError {
  const err = (json as { error?: { status?: string; message?: string; details?: unknown[] } })
    ?.error
  const blob = JSON.stringify(err?.details ?? '') + (err?.message ?? '')
  if (status === 429 || err?.status === 'RESOURCE_EXHAUSTED') return new GeminiError('quota')
  if (
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(`${err?.status}${blob}`)
  )
    return new GeminiError('invalid_key')
  if (status === 400) return new GeminiError('bad_request')
  if (status === 404) return new GeminiError('bad_request')
  return new GeminiError('bad_response')
}

export async function listModels(f: FetchLike, base: string, key: string): Promise<ModelInfo[]> {
  const json = await request(
    f,
    base,
    '/v1beta/models?pageSize=1000',
    key,
    { method: 'GET' },
    LIST_TIMEOUT_MS
  )
  const models = parseModels(json)
  if (!models.length) throw new GeminiError('bad_response')
  return models
}

export async function generate(
  f: FetchLike,
  base: string,
  key: string,
  model: string,
  system: string,
  prompt: string
): Promise<string> {
  if (!isValidModelId(model)) throw new GeminiError('bad_request')
  const json = (await request(
    f,
    base,
    `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    key,
    {
      method: 'POST',
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
      }
    },
    ASK_TIMEOUT_MS
  )) as {
    promptFeedback?: { blockReason?: string }
    candidates?: { finishReason?: string; content?: { parts?: { text?: unknown }[] } }[]
  }
  if (json.promptFeedback?.blockReason) throw new GeminiError('safety')
  const c = json.candidates?.[0]
  const text = (c?.content?.parts ?? [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim()
  if (!text) {
    if (c?.finishReason === 'SAFETY' || c?.finishReason === 'PROHIBITED_CONTENT')
      throw new GeminiError('safety')
    throw new GeminiError('bad_response')
  }
  if (c?.finishReason === 'SAFETY') throw new GeminiError('safety')
  return text
}
