import { GeminiError, quotaMessage } from './errors'

export const DEFAULT_BASE = 'https://generativelanguage.googleapis.com'
export const ALLOWED_HOST = 'generativelanguage.googleapis.com'
export const LIST_TIMEOUT_MS = 20_000
/** Non-streaming helper calls (cache creation): a total cap is fine, they return small bodies. */
export const ASK_TIMEOUT_MS = 60_000
/**
 * Generation streams: abort only when NO bytes arrive for this long. There is deliberately no cap
 * on the total time while data keeps flowing (a thinking model may take minutes).
 */
export const DEFAULT_IDLE_SEC = 90
export const MIN_IDLE_SEC = 15
export const MAX_IDLE_SEC = 600
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

/** Whole hyphen-separated tokens only, so e.g. "gemini-3-flash-preview" can never be filtered by accident. */
const NOT_TEXT =
  /(?:^|[-_/])(?:embedding|embeddings|aqa|imagen|veo|tts|image|live|native-audio|robotics|computer-use)(?:$|[-_/\d])/i

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
    if (!methods.includes('generateContent') && !methods.includes('streamGenerateContent')) continue
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
  /** user "stop": aborts the request cleanly (GeminiError 'aborted') */
  signal?: AbortSignal
  /** abort when no bytes arrive for this long (default 90 s); no cap on the total time */
  idleMs?: number
  /** called with each visible (non-thought) text delta as it arrives */
  onText?: (delta: string) => void
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

/** Token counts from usageMetadata (0 when Google did not report them). */
export interface Usage {
  promptTokens: number
  outputTokens: number
  /** hidden "thinking" tokens (billed, never shown) */
  thoughtsTokens: number
  cachedTokens: number
  totalTokens: number
}

export interface ChatResult extends GenerateResult {
  /** tokens served from a cache (implicit or explicit), when Google reports them */
  cachedTokens: number
  usage: Usage
}

export function userContent(text: string): Content {
  return { role: 'user', parts: [{ text }] }
}
export function modelContent(text: string): Content {
  return { role: 'model', parts: [{ text }] }
}

/**
 * Incremental Server-Sent-Events parser. Feed decoded text pieces split anywhere (even in the
 * middle of a line or of a CRLF); get back the `data:` payload of every COMPLETE event.
 */
export class SseParser {
  private buf = ''
  push(chunk: string): string[] {
    this.buf += chunk
    // normalise line ends, but keep a trailing CR: its LF may arrive in the next chunk
    const held = this.buf.endsWith('\r') ? '\r' : ''
    const body = held ? this.buf.slice(0, -1) : this.buf
    this.buf = body.replace(/\r\n?/g, '\n') + held
    const out: string[] = []
    for (;;) {
      const i = this.buf.indexOf('\n\n')
      if (i < 0) break
      const d = SseParser.dataOf(this.buf.slice(0, i))
      this.buf = this.buf.slice(i + 2)
      if (d !== null) out.push(d)
    }
    return out
  }
  /** end of stream: a final event without its blank line still counts */
  flush(): string[] {
    const rest = this.buf.replace(/\r/g, '\n').trim()
    this.buf = ''
    const d = rest ? SseParser.dataOf(rest) : null
    return d === null ? [] : [d]
  }
  get pending(): number {
    return this.buf.length
  }
  private static dataOf(block: string): string | null {
    const lines: string[] = []
    for (const l of block.split('\n')) {
      if (l.startsWith('data:')) lines.push(l.slice(5).replace(/^ /, ''))
    }
    return lines.length ? lines.join('\n') : null
  }
}

interface StreamJson {
  error?: { code?: number; status?: string; message?: string; details?: unknown[] }
  promptFeedback?: { blockReason?: string }
  usageMetadata?: Record<string, unknown>
  candidates?: {
    finishReason?: string
    content?: { parts?: { text?: unknown; thought?: unknown }[] }
  }[]
}

const MAX_STREAM_BUFFER = 16 * 1024 * 1024

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function parseUsage(u: Record<string, unknown> | undefined): Usage {
  return {
    promptTokens: num(u?.promptTokenCount),
    outputTokens: num(u?.candidatesTokenCount),
    thoughtsTokens: num(u?.thoughtsTokenCount),
    cachedTokens: num(u?.cachedContentTokenCount),
    totalTokens: num(u?.totalTokenCount)
  }
}

/** Accumulates stream events into the final answer (thought parts are never included). */
class StreamState {
  text = ''
  finish: string | undefined
  blocked: string | undefined
  usage: Record<string, unknown> | undefined
  constructor(private readonly onText?: (d: string) => void) {}
  event(j: StreamJson): void {
    if (j.error) throw httpError(typeof j.error.code === 'number' ? j.error.code : 0, j)
    if (j.promptFeedback?.blockReason) this.blocked = j.promptFeedback.blockReason
    if (j.usageMetadata) this.usage = j.usageMetadata
    const c = j.candidates?.[0]
    if (!c) return
    if (c.finishReason) this.finish = c.finishReason
    for (const p of c.content?.parts ?? []) {
      if (typeof p.text !== 'string' || p.thought === true || !p.text) continue
      this.text += p.text
      this.onText?.(p.text)
    }
  }
}

/**
 * One streaming generation request (`:streamGenerateContent?alt=sse`, key in the header).
 * The abort controller fires on (a) the caller's signal -> 'aborted' and (b) NO data for `idleMs`
 * -> 'timeout'. The idle timer restarts on every received chunk, so a long answer that keeps
 * flowing is never cut off. If a server/proxy ignores alt=sse and returns plain JSON (object or
 * array), that is parsed too.
 */
async function streamOnce(
  f: FetchLike,
  base: string,
  path: string,
  key: string,
  body: unknown,
  opts: GenerateOptions
): Promise<StreamState> {
  const url = `${base}${path}`
  assertAllowedUrl(url, base)
  if (opts.signal?.aborted) throw new GeminiError('aborted')
  const idleMs = opts.idleMs && opts.idleMs > 0 ? opts.idleMs : DEFAULT_IDLE_SEC * 1000
  const ac = new AbortController()
  let reason: 'idle' | 'user' | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      reason ??= 'idle'
      ac.abort()
    }, idleMs)
  }
  const onUser = (): void => {
    reason ??= 'user'
    ac.abort()
  }
  opts.signal?.addEventListener('abort', onUser, { once: true })
  arm()
  const st = new StreamState(opts.onText)
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: ac.signal
    })
    arm()
    if (!res.ok) {
      let json: unknown = null
      try {
        json = JSON.parse((await res.text()).slice(0, MAX_BODY_BYTES))
      } catch {
        json = null
      }
      if (res.status === 500 || res.status === 503)
        throw new GeminiError('bad_response', 'transient')
      throw httpError(res.status, json)
    }
    const dec = new TextDecoder()
    const sse = new SseParser()
    let mode: 'sse' | 'json' | null = null
    let raw = ''
    const eventData = (d: string): void => {
      if (d === '[DONE]') return
      let j: unknown
      try {
        j = JSON.parse(d)
      } catch {
        return // keep-alive or a partial line: ignore
      }
      if (j && typeof j === 'object') st.event(j as StreamJson)
    }
    const feed = (piece: string): void => {
      if (mode === null) {
        const first = piece.trimStart()[0]
        if (!first) return
        mode = first === '{' || first === '[' ? 'json' : 'sse'
      }
      if (mode === 'json') {
        raw += piece
        if (raw.length > MAX_STREAM_BUFFER) throw new GeminiError('bad_response')
        return
      }
      for (const d of sse.push(piece)) eventData(d)
      if (sse.pending > MAX_STREAM_BUFFER) throw new GeminiError('bad_response')
    }
    if (res.body) {
      const rd = res.body.getReader()
      for (;;) {
        const { done, value } = await rd.read()
        if (done) break
        arm() // bytes arrived: the model is alive
        feed(dec.decode(value, { stream: true }))
      }
      feed(dec.decode())
    } else feed(await res.text())
    if (mode === 'json') {
      let j: unknown
      try {
        j = JSON.parse(raw)
      } catch {
        throw new GeminiError('bad_response')
      }
      for (const x of Array.isArray(j) ? j : [j]) if (x && typeof x === 'object') st.event(x)
    } else for (const d of sse.flush()) eventData(d)
    return st
  } catch (e) {
    if (reason === 'idle') throw new GeminiError('timeout')
    if (reason === 'user') throw new GeminiError('aborted')
    if (e instanceof GeminiError) throw e
    throw new GeminiError('offline')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onUser)
  }
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
  const body = {
    ...(input.cachedContent
      ? { cachedContent: input.cachedContent }
      : input.system
        ? { systemInstruction: { parts: [{ text: input.system }] } }
        : {}),
    contents: input.contents,
    generationConfig: generationConfig(model, opts.outputTokenLimit)
  }
  const path = `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
  const sleep = opts.sleep ?? defaultSleep
  let st: StreamState
  for (let attempt = 0; ; attempt++) {
    try {
      st = await streamOnce(f, base, path, key, body, opts)
      break
    } catch (e) {
      const transient = e instanceof GeminiError && e.message === 'transient'
      if (!transient) throw e
      if (attempt >= BACKOFF_MS.length) throw new GeminiError('bad_response')
      await sleep(BACKOFF_MS[attempt])
      if (opts.signal?.aborted) throw new GeminiError('aborted')
    }
  }
  if (st.blocked) throw new GeminiError(st.blocked === 'OTHER' ? 'blocked_other' : 'safety')
  const text = st.text.trim()
  const fr = st.finish
  if (!text) {
    if (fr === 'SAFETY' || fr === 'PROHIBITED_CONTENT' || fr === 'BLOCKLIST' || fr === 'SPII')
      throw new GeminiError('safety')
    if (fr === 'RECITATION') throw new GeminiError('recitation')
    if (fr === 'MAX_TOKENS') throw new GeminiError('empty')
    if (fr === 'OTHER') throw new GeminiError('blocked_other')
    throw new GeminiError('bad_response')
  }
  if (fr === 'SAFETY') throw new GeminiError('safety')
  const usage = parseUsage(st.usage)
  return { text, cutoff: fr === 'MAX_TOKENS', cachedTokens: usage.cachedTokens, usage }
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
): Promise<ChatResult> {
  const contents: Content[] = [userContent(prompt)]
  if (opts.continueFrom) {
    contents.push(modelContent(opts.continueFrom), userContent(CONTINUE_PROMPT))
  }
  const r = await generateChat(f, base, key, model, { system, contents }, opts)
  return r
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
