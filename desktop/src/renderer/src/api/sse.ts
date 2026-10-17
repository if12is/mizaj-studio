import { ApiError, parseError } from './client'
import { getApiToken, withToken } from './token'
import type { StreamChunk } from '@renderer/editor/runSession'

export interface SseEvent {
  event: string
  data: string
}

/** Incremental SSE parser, robust to arbitrary chunk boundaries. */
export class SseParser {
  private buf = ''
  private ev = ''
  private data: string[] = []

  feed(chunk: string): SseEvent[] {
    this.buf += chunk
    const out: SseEvent[] = []
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf)
      if (!m) break
      // a trailing lone \r may be the first half of \r\n
      if (m[0] === '\r' && m.index === this.buf.length - 1) break
      const line = this.buf.slice(0, m.index)
      this.buf = this.buf.slice(m.index + m[0].length)
      const e = this.line(line)
      if (e) out.push(e)
    }
    return out
  }

  /** Call at end of stream to emit a final unterminated event. */
  end(): SseEvent[] {
    const out: SseEvent[] = []
    if (this.buf) {
      const e = this.line(this.buf.replace(/\r$/, ''))
      this.buf = ''
      if (e) out.push(e)
    }
    const e = this.line('')
    if (e) out.push(e)
    return out
  }

  private line(line: string): SseEvent | null {
    if (line === '') {
      if (!this.data.length) {
        this.ev = ''
        return null
      }
      const e = { event: this.ev || 'message', data: this.data.join('\n') }
      this.ev = ''
      this.data = []
      return e
    }
    if (line.startsWith(':')) return null
    const i = line.indexOf(':')
    const field = i < 0 ? line : line.slice(0, i)
    let value = i < 0 ? '' : line.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.ev = value
    else if (field === 'data') this.data.push(value)
    return null
  }
}

export interface DoneInfo {
  chunks: number
  cached_chunks: number
  words: number
  progress: number
  engine: string
  elapsed_ms: number
  wps: number
}

export type StreamMsg =
  | { type: 'waiting' }
  | { type: 'chunk'; chunk: StreamChunk }
  | { type: 'done'; info: DoneInfo }
  | { type: 'error'; error: ApiError }

export interface StreamOptions {
  baseUrl: string
  body: Record<string, unknown>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  maxEngineRetries?: number
  /** defaults to the shared per-launch token */
  token?: string | null
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Map a parsed SSE event to a stream message (null = ignore). */
export function toStreamMsg(e: SseEvent): StreamMsg | null {
  let payload: unknown
  try {
    payload = JSON.parse(e.data)
  } catch {
    return null
  }
  if (e.event === 'done') return { type: 'done', info: payload as DoneInfo }
  if (e.event === 'error') {
    const p = payload as { error_code?: string; message_ar?: string; message_en?: string }
    return {
      type: 'error',
      error: new ApiError(
        200,
        p.error_code ?? 'ERR_UNKNOWN',
        p.message_ar ?? 'حدث خطأ أثناء التشكيل.',
        p.message_en ?? ''
      )
    }
  }
  return { type: 'chunk', chunk: payload as StreamChunk }
}

/** POST /api/tashkeel/stream via fetch + ReadableStream (EventSource cannot POST). */
export async function* streamTashkeel(o: StreamOptions): AsyncGenerator<StreamMsg> {
  const f = o.fetchImpl ?? fetch
  const sleep = o.sleep ?? defaultSleep
  const max = o.maxEngineRetries ?? 60
  let res: Response | null = null
  for (let attempt = 0; ; attempt++) {
    res = await f(`${o.baseUrl}/api/tashkeel/stream`, {
      method: 'POST',
      headers: withToken(
        { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        o.token === undefined ? getApiToken() : o.token
      ),
      body: JSON.stringify(o.body),
      signal: o.signal
    })
    if (res.ok) break
    const err = await parseError(res)
    if (res.status === 503 && err.errorCode === 'ERR_ENGINE_NOT_READY' && attempt < max) {
      yield { type: 'waiting' }
      await sleep(1000)
      continue
    }
    yield { type: 'error', error: err }
    return
  }
  if (!res.body) {
    yield { type: 'error', error: new ApiError(0, 'ERR_NETWORK', 'تعذر قراءة البث.', 'no body') }
    return
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const parser = new SseParser()
  for (;;) {
    const { done, value } = await reader.read()
    const events = done ? parser.end() : parser.feed(dec.decode(value, { stream: true }))
    for (const e of events) {
      const m = toStreamMsg(e)
      if (m) yield m
    }
    if (done) break
  }
}
