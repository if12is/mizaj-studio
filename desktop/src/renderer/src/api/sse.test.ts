import { describe, expect, it, vi } from 'vitest'
import { SseParser, streamTashkeel, type StreamMsg } from './sse'

const chunkEv = (id: number) =>
  `data: ${JSON.stringify({ chunk_id: id, start: 0, end: 1, text: 'ا', progress: 50, wps: 1, cached: 0 })}\n\n`
const doneEv = `event: done\ndata: {"chunks":1,"words":1,"progress":100}\n\n`

describe('SseParser', () => {
  it('parses multiple events in one chunk', () => {
    const p = new SseParser()
    const ev = p.feed(chunkEv(1) + chunkEv(2) + doneEv)
    expect(ev.map((e) => e.event)).toEqual(['message', 'message', 'done'])
  })
  it('is robust to every possible split point (incl. CRLF)', () => {
    const full = (chunkEv(1) + doneEv + 'event: error\r\ndata: {"error_code":"X"}\r\n\r\n').replace(
      /\n(?!\n)/g,
      '\n'
    )
    for (let i = 1; i < full.length; i++) {
      const p = new SseParser()
      const ev = [...p.feed(full.slice(0, i)), ...p.feed(full.slice(i)), ...p.end()]
      expect(ev.map((e) => e.event)).toEqual(['message', 'done', 'error'])
    }
  })
  it('handles multi-line data, comments and arabic payloads', () => {
    const p = new SseParser()
    const ev = p.feed(': keepalive\n\ndata: a\ndata: ب\n\n')
    expect(ev).toEqual([{ event: 'message', data: 'a\nب' }])
  })
})

function streamOf(parts: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p))
      c.close()
    }
  })
  return new Response(body, { status: 200 })
}
async function collect(g: AsyncGenerator<StreamMsg>): Promise<StreamMsg[]> {
  const out: StreamMsg[] = []
  for await (const m of g) out.push(m)
  return out
}

describe('streamTashkeel', () => {
  it('yields chunks then done, with bytes split mid multi-byte char', async () => {
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ chunk_id: 1, start: 0, end: 2, text: 'كَتَب', progress: 50, wps: 2, cached: 0 })}\n\n` +
        doneEv
    )
    const cut = 20
    const enc = (u: Uint8Array) => u
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc(bytes.slice(0, cut)))
        c.enqueue(enc(bytes.slice(cut)))
        c.close()
      }
    })
    const f = vi.fn(async () => new Response(body, { status: 200 }))
    const msgs = await collect(
      streamTashkeel({ baseUrl: 'http://x', body: {}, fetchImpl: f as never })
    )
    expect(msgs.map((m) => m.type)).toEqual(['chunk', 'done'])
    expect((msgs[0] as { chunk: { text: string } }).chunk.text).toBe('كَتَب')
  })

  it('surfaces SSE error events with message_ar', async () => {
    const f = async () =>
      streamOf([
        `event: error\ndata: {"error_code":"ERR_X","message_ar":"فشل","message_en":"f"}\n\n`
      ])
    const msgs = await collect(
      streamTashkeel({ baseUrl: 'http://x', body: {}, fetchImpl: f as never })
    )
    expect(msgs[0].type).toBe('error')
    expect((msgs[0] as { error: { messageAr: string } }).error.messageAr).toBe('فشل')
  })

  it('retries 503 ERR_ENGINE_NOT_READY after 1s then streams', async () => {
    const notReady = () =>
      new Response(
        JSON.stringify({
          error_code: 'ERR_ENGINE_NOT_READY',
          message_ar: 'a',
          message_en: 'b',
          details: {}
        }),
        { status: 503 }
      )
    const f = vi
      .fn()
      .mockResolvedValueOnce(notReady())
      .mockResolvedValueOnce(notReady())
      .mockResolvedValueOnce(streamOf([doneEv]))
    const sleep = vi.fn(async () => {})
    const msgs = await collect(
      streamTashkeel({ baseUrl: 'http://x', body: {}, fetchImpl: f as never, sleep })
    )
    expect(sleep).toHaveBeenCalledWith(1000)
    expect(msgs.map((m) => m.type)).toEqual(['waiting', 'waiting', 'done'])
  })

  it('reports non-503 http errors from the envelope', async () => {
    const f = async () =>
      new Response(
        JSON.stringify({
          error_code: 'ERR_VALIDATION',
          message_ar: 'غير صالح',
          message_en: 'x',
          details: {}
        }),
        { status: 422 }
      )
    const msgs = await collect(
      streamTashkeel({ baseUrl: 'http://x', body: {}, fetchImpl: f as never })
    )
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as { error: { errorCode: string } }).error.errorCode).toBe('ERR_VALIDATION')
  })
})
