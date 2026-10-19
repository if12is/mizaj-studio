import { GeminiError, quotaMessage } from './errors'

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
  inputTokenLimit?: number
  outputTokenLimit?: number
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
      inputTokenLimit?: unknown
      outputTokenLimit?: unknown
    }
    if (typeof r.name !== 'string') continue
    const methods = Array.isArray(r.supportedGenerationMethods) ? r.supportedGenerationMethods : []
    if (!methods.includes('generateContent')) continue
    const id = r.name.replace(/^models\//, '')
    if (!isValidModelId(id) || NOT_TEXT.test(id)) continue
    const lim = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
    const info: ModelInfo = {
      id,
      display: typeof r.displayName === 'string' ? r.displayName : id
    }
    const il = lim(r.inputTokenLimit)
    const ol = lim(r.outputTokenLimit)
    if (il) info.inputTokenLimit = il
    if (ol) info.outputTokenLimit = ol
    out.push(info)
  }
  return sortModels(out)
}

export type FetchLike = typeof fetch

export type Sleep = (ms: number) => Promise<void>
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** waits before retry 1 and 2 after a 500/503 */
export const BACKOFF_MS = [1_000, 3_000]

async function request(
  f: FetchLike,
  base: string,
  path: string,
  key: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  timeoutMs: number,
  sleep?: Sleep
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(f, base, path, key, init, timeoutMs)
    } catch (e) {
      const transient = e instanceof GeminiError && e.message === 'transient'
      if (!sleep || !transient || attempt >= BACKOFF_MS.length) {
        if (transient) throw new GeminiError('bad_response')
        throw e
      }
      await sleep(BACKOFF_MS[attempt])
    }
  }
}

async function requestOnce(
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
  if (!res.ok) {
    if (res.status === 500 || res.status === 503) throw new GeminiError('bad_response', 'transient')
    throw httpError(res.status, json)
  }
  if (json === null) throw new GeminiError('bad_response')
  return json
}

/** auto-retry waits at most this long (the UI shows a countdown) */
export const MAX_AUTO_RETRY_SEC = 30

/** RetryInfo.retryDelay ("27s", "1.5s") from error details, else "retry in 27.1s" in the message. */
export function parseRetryDelay(details: unknown, message?: string): number | undefined {
  if (Array.isArray(details)) {
    for (const d of details) {
      const v = (d as { retryDelay?: unknown })?.retryDelay
      if (typeof v === 'string') {
        const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim())
        if (m) return parseFloat(m[1])
      }
    }
  }
  const m = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(message ?? '')
  return m ? parseFloat(m[1]) : undefined
}

export function httpError(status: number, json: unknown): GeminiError {
  const err = (json as { error?: { status?: string; message?: string; details?: unknown[] } })
    ?.error
  const blob = JSON.stringify(err?.details ?? '') + (err?.message ?? '')
  if (status === 429 || err?.status === 'RESOURCE_EXHAUSTED') {
    const sec = parseRetryDelay(err?.details, err?.message)
    return new GeminiError(
      'quota',
      quotaMessage(sec && sec > MAX_AUTO_RETRY_SEC ? sec : undefined),
      sec,
      status
    )
  }
  if (
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(`${err?.status}${blob}`)
  )
    return new GeminiError('invalid_key', undefined, undefined, status)
  if (status === 400 || status === 404)
    return new GeminiError('bad_request', undefined, undefined, status)
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

export interface GenerateOptions {
  /** model limits from the models list, when known */
  outputTokenLimit?: number
  /** the partial answer so far: ask the model to continue it */
  continueFrom?: string
  sleep?: Sleep
}

export interface GenerateResult {
  text: string
  /** the model stopped because it hit the output budget */
  cutoff: boolean
}

export const DEFAULT_MAX_OUTPUT = 8192
export const CONTINUE_PROMPT = 'تابع الإجابة من حيث توقفت تماماً دون تكرار ما سبق.'

export function generationConfig(
  model: string,
  outputTokenLimit?: number
): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    temperature: 0.2,
    maxOutputTokens: Math.min(DEFAULT_MAX_OUTPUT, outputTokenLimit ?? DEFAULT_MAX_OUTPUT)
  }
  // 2.5 models spend the output budget on hidden "thinking": keep it modest.
  if (/^gemini-2\.5-(flash|pro)(?!-lite)/.test(model)) cfg.thinkingConfig = { thinkingBudget: 1024 }
  return cfg
}

export interface Content {
  role: 'user' | 'model'
  parts: { text: string }[]
}

export interface GenerateInput {
  /** omitted when `cachedContent` is used (the cache already holds the system instruction) */
  system?: string
  contents: Content[]
  /** resource name of an explicit cache ("cachedContents/abc") */
  cachedContent?: string
}

export interface ChatResult extends GenerateResult {
  /** tokens served from a cache (implicit or explicit), when Google reports them */
  cachedTokens: number
}

export function userContent(text: string): Content {
  return { role: 'user', parts: [{ text }] }
}
export function modelContent(text: string): Content {
  return { role: 'model', parts: [{ text }] }
}

export async function generateChat(
  f: FetchLike,
  base: string,
  key: string,
  model: string,
  input: GenerateInput,
  opts: GenerateOptions = {}
): Promise<ChatResult> {
  if (!isValidModelId(model)) throw new GeminiError('bad_request')
  const json = (await request(
    f,
    base,
    `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    key,
    {
      method: 'POST',
      body: {
        ...(input.cachedContent
          ? { cachedContent: input.cachedContent }
          : input.system
            ? { systemInstruction: { parts: [{ text: input.system }] } }
            : {}),
        contents: input.contents,
        generationConfig: generationConfig(model, opts.outputTokenLimit)
      }
    },
    ASK_TIMEOUT_MS,
    opts.sleep ?? defaultSleep
  )) as {
    promptFeedback?: { blockReason?: string }
    usageMetadata?: { cachedContentTokenCount?: unknown }
    candidates?: {
      finishReason?: string
      content?: { parts?: { text?: unknown; thought?: unknown }[] }
    }[]
  }
  if (json.promptFeedback?.blockReason) {
    throw new GeminiError(json.promptFeedback.blockReason === 'OTHER' ? 'blocked_other' : 'safety')
  }
  const c = json.candidates?.[0]
  const text = (c?.content?.parts ?? [])
    .map((p) => (typeof p.text === 'string' && p.thought !== true ? p.text : ''))
    .join('')
    .trim()
  const fr = c?.finishReason
  if (!text) {
    if (fr === 'SAFETY' || fr === 'PROHIBITED_CONTENT' || fr === 'BLOCKLIST' || fr === 'SPII')
      throw new GeminiError('safety')
    if (fr === 'RECITATION') throw new GeminiError('recitation')
    if (fr === 'MAX_TOKENS') throw new GeminiError('empty')
    if (fr === 'OTHER') throw new GeminiError('blocked_other')
    throw new GeminiError('bad_response')
  }
  if (fr === 'SAFETY') throw new GeminiError('safety')
  const ct = json.usageMetadata?.cachedContentTokenCount
  return { text, cutoff: fr === 'MAX_TOKENS', cachedTokens: typeof ct === 'number' ? ct : 0 }
}

/** Stateless single-turn call (word questions; continuation of a stateless answer). */
export async function generate(
  f: FetchLike,
  base: string,
  key: string,
  model: string,
  system: string,
  prompt: string,
  opts: GenerateOptions = {}
): Promise<GenerateResult> {
  const contents: Content[] = [userContent(prompt)]
  if (opts.continueFrom) {
    contents.push(modelContent(opts.continueFrom), userContent(CONTINUE_PROMPT))
  }
  const r = await generateChat(f, base, key, model, { system, contents }, opts)
  return { text: r.text, cutoff: r.cutoff }
}

export const CACHE_TTL_SEC = 3600

export interface CreatedCache {
  name: string
  /** epoch ms after which the cache is considered gone (client clock, with a safety margin) */
  expiresAt: number
}

/** Explicit context cache holding the system instruction + the document turns. */
export async function createCache(
  f: FetchLike,
  base: string,
  key: string,
  model: string,
  system: string,
  contents: Content[],
  now: () => number = Date.now
): Promise<CreatedCache> {
  if (!isValidModelId(model)) throw new GeminiError('bad_request')
  const json = (await request(
    f,
    base,
    '/v1beta/cachedContents',
    key,
    {
      method: 'POST',
      body: {
        model: `models/${model}`,
        systemInstruction: { parts: [{ text: system }] },
        contents,
        ttl: `${CACHE_TTL_SEC}s`
      }
    },
    ASK_TIMEOUT_MS
  )) as { name?: unknown }
  if (typeof json.name !== 'string' || !/^cachedContents\/[A-Za-z0-9_-]{1,128}$/.test(json.name))
    throw new GeminiError('bad_response')
  return { name: json.name, expiresAt: now() + (CACHE_TTL_SEC - 120) * 1000 }
}
