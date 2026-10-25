import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BASE, generateChat, parseModels, SseParser, userContent } from './api'
import { GeminiConfigStore } from './config'
import { GeminiError } from './errors'
import { GeminiKeyStore } from './keyStore'
import { GeminiService } from './service'
import { SessionStore } from './sessions'

const KEY = 'AQ.Ab8RN6SecretKeyShapeThatIsNotAIza_0123456789'
const enc = new TextEncoder()
const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\r\n\r\n`
const part = (text: string, extra: Record<string, unknown> = {}): unknown => ({
  candidates: [{ content: { parts: [{ text, ...extra }] } }],
  ...extra
})
const input = { system: 's', contents: [userContent('q')] }

/** A fetch whose response body the test drives by hand; it honours the abort signal. */
function manual() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const seen: { url?: string; init?: RequestInit; signal?: AbortSignal } = {}
  const f = (async (url: string, init: RequestInit) => {
    seen.url = url
    seen.init = init
    seen.signal = init.signal as AbortSignal
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c
        init.signal!.addEventListener('abort', () =>
          c.error(new DOMException('aborted', 'AbortError'))
        )
      }
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return {
    f,
    seen,
    push: (s: string) => ctrl.enqueue(enc.encode(s)),
    bytes: (b: Uint8Array) => ctrl.enqueue(b),
    end: () => ctrl.close()
  }
}

describe('SseParser', () => {
  it('returns only complete events and handles any split, including inside CRLF', () => {
    const raw =
      'data: {"a":1}\r\n\r\ndata: {"b":\r\ndata: 2}\r\n\r\n: keep-alive\n\ndata: {"c":3}\n\n'
    const whole = new SseParser().push(raw)
    expect(whole).toEqual(['{"a":1}', '{"b":\n2}', '{"c":3}'])
    for (let cut = 1; cut < raw.length; cut++) {
      const p = new SseParser()
      const got = [...p.push(raw.slice(0, cut)), ...p.push(raw.slice(cut))]
      expect(got, `cut at ${cut}`).toEqual(whole)
    }
    // one character at a time
    const p = new SseParser()
    const got: string[] = []
    for (const ch of raw) got.push(...p.push(ch))
    expect(got).toEqual(whole)
  })
  it('flush() yields a last event that lacks its blank line', () => {
    const p = new SseParser()
    expect(p.push('data: {"x":1}')).toEqual([])
    expect(p.flush()).toEqual(['{"x":1}'])
  })
})

describe('streaming generation', () => {
  it('uses streamGenerateContent?alt=sse with the key only in the x-goog-api-key header', async () => {
    const m = manual()
    const p = generateChat(m.f, DEFAULT_BASE, KEY, 'gemini-flash-latest', input)
    await vi.waitFor(() => expect(m.seen.url).toBeDefined())
    m.push(sse(part('ok')))
    m.end()
    await p
    expect(m.seen.url).toBe(
      `${DEFAULT_BASE}/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse`
    )
    expect((m.seen.init!.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY)
    expect(m.seen.url).not.toContain(KEY)
    expect(String(m.seen.init!.body)).not.toContain(KEY)
  })

  it('assembles text split across chunk boundaries, even inside a multibyte character', async () => {
    const m = manual()
    const deltas: string[] = []
    const p = generateChat(m.f, DEFAULT_BASE, KEY, 'gemini-2.5-flash', input, {
      onText: (d) => deltas.push(d)
    })
    await vi.waitFor(() => expect(m.seen.url).toBeDefined())
    const all = enc.encode(
      sse(part('مرحباً ')) +
        sse(part('بالعالم')) +
        sse({ ...(part('!') as object), usageMetadata: { totalTokenCount: 9 } })
    )
    // cut at awkward byte offsets (the Arabic letters are 2 bytes each)
    for (const [a, b] of [
      [0, 7],
      [7, 30],
      [30, 31],
      [31, 77],
      [77, all.length]
    ])
      m.bytes(all.slice(a, b))
    m.end()
    const r = await p
    expect(r.text).toBe('مرحباً بالعالم!')
    expect(deltas.join('')).toBe('مرحباً بالعالم!')
    expect(deltas.length).toBeGreaterThanOrEqual(3)
  })

  it('never exposes thought parts and reports usage metadata', async () => {
    const m = manual()
    const deltas: string[] = []
    const p = generateChat(m.f, DEFAULT_BASE, KEY, 'gemini-3-flash-preview', input, {
      onText: (d) => deltas.push(d)
    })
    await vi.waitFor(() => expect(m.seen.url).toBeDefined())
    m.push(sse({ candidates: [{ content: { parts: [{ text: 'تفكير سري', thought: true }] } }] }))
    m.push(
      sse({
        candidates: [{ content: { parts: [{ text: 'الجواب' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 300,
          cachedContentTokenCount: 50,
          totalTokenCount: 420
        }
      })
    )
    m.end()
    const r = await p
    expect(r.text).toBe('الجواب')
    expect(deltas.join('')).not.toContain('تفكير')
    expect(r.usage).toEqual({
      promptTokens: 100,
      outputTokens: 20,
      thoughtsTokens: 300,
      cachedTokens: 50,
      totalTokens: 420
    })
    expect(r.cachedTokens).toBe(50)
  })

  it('thoughts only + MAX_TOKENS is the clear «empty» error; MAX_TOKENS with text is a cutoff', async () => {
    const a = manual()
    const pa = generateChat(a.f, DEFAULT_BASE, KEY, 'm', input)
    await vi.waitFor(() => expect(a.seen.url).toBeDefined())
    a.push(
      sse({
        candidates: [
          { content: { parts: [{ text: 'x', thought: true }] }, finishReason: 'MAX_TOKENS' }
        ]
      })
    )
    a.end()
    await expect(pa).rejects.toMatchObject({ code: 'empty' })
    const b = manual()
    const pb = generateChat(b.f, DEFAULT_BASE, KEY, 'm', input)
    await vi.waitFor(() => expect(b.seen.url).toBeDefined())
    b.push(
      sse({ candidates: [{ content: { parts: [{ text: 'نصف' }] }, finishReason: 'MAX_TOKENS' }] })
    )
    b.end()
    expect(await pb).toMatchObject({ text: 'نصف', cutoff: true })
  })

  it('an error object inside the stream is mapped (quota keeps its retry delay)', async () => {
    const m = manual()
    const p = generateChat(m.f, DEFAULT_BASE, KEY, 'm', input)
    await vi.waitFor(() => expect(m.seen.url).toBeDefined())
    m.push(
      sse({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          details: [{ retryDelay: '12s' }]
        }
      })
    )
    m.end()
    await expect(p).rejects.toMatchObject({ code: 'quota', retryAfterSec: 12 })
  })

  it('still understands a plain JSON array/object reply (server ignoring alt=sse)', async () => {
    const f = (async () =>
      new Response(JSON.stringify([part('أ'), part('ب')]), {
        status: 200
      })) as unknown as typeof fetch
    expect((await generateChat(f, DEFAULT_BASE, KEY, 'm', input)).text).toBe('أب')
  })
})

describe('idle timeout (no total cap)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires when no bytes arrive for the idle time, keeping what was already delivered', async () => {
    const m = manual()
    const deltas: string[] = []
    const p = generateChat(m.f, DEFAULT_BASE, KEY, 'm', input, {
      idleMs: 90_000,
      onText: (d) => deltas.push(d)
    })
    const caught = p.catch((e) => e as GeminiError)
    await vi.advanceTimersByTimeAsync(0)
    m.push(sse(part('بداية')))
    await vi.advanceTimersByTimeAsync(89_000)
    expect(m.seen.signal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1_500)
    const e = await caught
    expect(e).toBeInstanceOf(GeminiError)
    expect((e as GeminiError).code).toBe('timeout')
    expect(m.seen.signal!.aborted).toBe(true)
    expect(deltas).toEqual(['بداية'])
  })

  it('fires while still waiting for the first byte (a model that never answers)', async () => {
    const m = manual()
    const p = generateChat(m.f, DEFAULT_BASE, KEY, 'm', input, { idleMs: 20_000 })
    const caught = p.catch((e) => e as GeminiError)
    await vi.advanceTimersByTimeAsync(20_100)
    expect(((await caught) as GeminiError).code).toBe('timeout')
  })

  it('does NOT fire while data keeps flowing, however long the total (10 minutes here)', async () => {
    const m = manual()
    const p = generateChat(m.f, DEFAULT_BASE, KEY, 'm', input, { idleMs: 90_000 })
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(30_000) // 20 x 30 s = 600 s, each gap < 90 s
      m.push(sse(part(`${i} `)))
    }
    expect(m.seen.signal!.aborted).toBe(false)
    m.push(sse({ candidates: [{ content: { parts: [{ text: 'ز' }] }, finishReason: 'STOP' }] }))
    m.end()
    const r = await p
    expect(r.text.startsWith('0 1 2')).toBe(true)
    expect(r.text.endsWith('ز')).toBe(true)
  })

  it('the service passes the configured idle time (advanced settings) to the request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-idle-'))
    try {
      const m = manual()
      const cfg = new GeminiConfigStore(join(dir, 'c.json'))
      const keys = new GeminiKeyStore(join(dir, 'k.bin'), {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s),
        decryptString: (b) => b.toString()
      })
      keys.save(KEY)
      const s = new GeminiService({
        keys,
        config: cfg,
        base: DEFAULT_BASE,
        sessions: new SessionStore(join(dir, 's')),
        fetch: m.f
      })
      s.setConfig({ enabled: true, model: 'gemini-flash-latest', idleTimeoutSec: 15 })
      s.acceptConsent()
      const r = s.ask({ kind: 'document', question: 'لخّص', text: 'نص' })
      await vi.advanceTimersByTimeAsync(14_000)
      expect(m.seen.signal!.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(await r).toMatchObject({ ok: false, code: 'timeout' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('abort («إيقاف»)', () => {
  it('aborts a running stream cleanly with the aborted code and the partial text kept by the caller', async () => {
    const m = manual()
    const ac = new AbortController()
    const deltas: string[] = []
    const p = generateChat(m.f, DEFAULT_BASE, KEY, 'm', input, {
      signal: ac.signal,
      onText: (d) => deltas.push(d)
    })
    const caught = p.catch((e) => e as GeminiError)
    await vi.waitFor(() => expect(m.seen.url).toBeDefined())
    m.push(sse(part('جزء')))
    await vi.waitFor(() => expect(deltas).toEqual(['جزء']))
    ac.abort()
    const e = (await caught) as GeminiError
    expect(e.code).toBe('aborted')
    expect(m.seen.signal!.aborted).toBe(true)
  })
  it('an already-aborted signal sends nothing', async () => {
    const f = vi.fn()
    const ac = new AbortController()
    ac.abort()
    await expect(
      generateChat(f as unknown as typeof fetch, DEFAULT_BASE, KEY, 'm', input, {
        signal: ac.signal
      })
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('model list keeps the latest Flash ids', () => {
  const M = (name: string, methods = ['generateContent', 'streamGenerateContent']) => ({
    name: `models/${name}`,
    supportedGenerationMethods: methods
  })
  it('does not filter flash / flash-lite / preview / latest ids; filters non-text ones', () => {
    const ids = parseModels({
      models: [
        M('gemini-flash-latest'),
        M('gemini-flash-lite-latest'),
        M('gemini-3-flash-preview'),
        M('gemini-3.1-flash-lite-preview'),
        M('gemini-2.5-flash'),
        M('gemini-2.5-flash-lite'),
        M('gemini-3-pro-image-preview'),
        M('gemini-2.5-flash-image'),
        M('gemini-2.5-flash-preview-tts'),
        M('gemini-2.0-flash-live-001'),
        M('gemini-embedding-001', ['embedContent']),
        M('veo-3.0-generate-001', ['predictLongRunning'])
      ]
    }).map((x) => x.id)
    for (const id of [
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite'
    ])
      expect(ids, id).toContain(id)
    for (const id of [
      'gemini-3-pro-image-preview',
      'gemini-2.5-flash-image',
      'gemini-2.5-flash-preview-tts',
      'gemini-2.0-flash-live-001',
      'gemini-embedding-001',
      'veo-3.0-generate-001'
    ])
      expect(ids, id).not.toContain(id)
  })
})

describe('key validation flow and redaction', () => {
  let dir: string
  let logs: string[]
  let calls: { url: string; key: string | undefined }[]
  let handler: (url: string) => Response | Promise<Response>
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s).reverse(),
    decryptString: (b: Buffer) => Buffer.from(b).reverse().toString()
  }
  const list = () =>
    new Response(
      JSON.stringify({
        models: [
          { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }
        ]
      }),
      { status: 200 }
    )
  const svc = () =>
    new GeminiService({
      keys: new GeminiKeyStore(join(dir, 'k.bin'), storage),
      config: new GeminiConfigStore(join(dir, 'c.json')),
      base: DEFAULT_BASE,
      sessions: new SessionStore(join(dir, 's')),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, key: (init.headers as Record<string, string>)['x-goog-api-key'] })
        return handler(url)
      }) as unknown as typeof fetch
    })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mz-keyflow-'))
    logs = []
    calls = []
    handler = list
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })
  const bad = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  it('accepts a key of any shape (AQ…), saves, then tests it live with the header', async () => {
    const s = svc()
    const r = await s.saveKey(`  ${KEY}\n`)
    expect(r).toMatchObject({ ok: true, check: { ok: true } })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/v1beta/models')
    expect(calls[0].url).not.toContain(KEY)
    expect(calls[0].key).toBe(KEY)
    expect(new GeminiKeyStore(join(dir, 'k.bin'), storage).load()).toBe(KEY)
  })

  it('rejects empty / spaced / multi-line input without any request', async () => {
    const s = svc()
    for (const k of ['', '   ', 'abc def', 'abc\ndef', 'ab\tc', 12 as unknown])
      expect(await s.saveKey(k), String(k)).toMatchObject({ ok: false, code: 'invalid_key' })
    expect(calls).toHaveLength(0)
    expect(await s.testKey('a b')).toMatchObject({ ok: false, code: 'invalid_key' })
  })

  it('Google says the key is invalid (400 API_KEY_INVALID): not kept, previous key restored', async () => {
    const s = svc()
    await s.saveKey('GOODKEY-1')
    handler = () =>
      bad(400, {
        error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }
      })
    const r = await s.saveKey(KEY)
    expect(r).toMatchObject({ ok: false, code: 'invalid_key' })
    expect(r.ok === false && r.message).toMatch(/[؀-ۿ]/)
    expect(new GeminiKeyStore(join(dir, 'k.bin'), storage).load()).toBe('GOODKEY-1')
    // with no previous key nothing is left behind
    rmSync(join(dir, 'k.bin'))
    await s.saveKey(KEY)
    expect(new GeminiKeyStore(join(dir, 'k.bin'), storage).has()).toBe(false)
  })

  it('maps 401/403 to invalid_key, 429 to quota and a network failure to offline', async () => {
    const s = svc()
    handler = () => bad(403, { error: { status: 'PERMISSION_DENIED' } })
    expect(await s.testKey(KEY)).toMatchObject({ ok: false, code: 'invalid_key' })
    handler = () => bad(401, {})
    expect(await s.testKey(KEY)).toMatchObject({ ok: false, code: 'invalid_key' })
    handler = () => bad(429, { error: { status: 'RESOURCE_EXHAUSTED' } })
    expect(await s.testKey(KEY)).toMatchObject({ ok: false, code: 'quota' })
    handler = () => {
      throw new TypeError(`fetch failed for key ${KEY}`)
    }
    const off = await s.testKey(KEY)
    expect(off).toMatchObject({ ok: false, code: 'offline' })
  })

  it('on quota/offline the key stays saved and the reason is reported', async () => {
    const s = svc()
    handler = () => bad(429, { error: { status: 'RESOURCE_EXHAUSTED' } })
    const r = await s.saveKey(KEY)
    expect(r).toMatchObject({ ok: true, check: { ok: false, code: 'quota' } })
    expect(new GeminiKeyStore(join(dir, 'k.bin'), storage).load()).toBe(KEY)
  })

  it('the key never appears in logs, errors, state or outcomes', async () => {
    const s = svc()
    const seen: string[] = []
    for (const h of [
      () =>
        bad(400, { error: { status: 'INVALID_ARGUMENT', message: `API key not valid ${KEY}` } }),
      () => bad(429, { error: { message: `quota for ${KEY}` } }),
      () => bad(500, { error: { message: KEY } }),
      () => {
        throw new Error(`boom ${KEY}`)
      }
    ]) {
      handler = h
      seen.push(JSON.stringify(await s.testKey(KEY)), JSON.stringify(await s.saveKey(KEY)))
    }
    handler = list
    await s.saveKey(KEY)
    s.setConfig({ enabled: true, model: 'gemini-flash-latest' })
    s.acceptConsent()
    handler = () => {
      throw new Error(`stream boom ${KEY}`)
    }
    seen.push(JSON.stringify(await s.ask({ kind: 'document', question: 'س', text: 'ن' })))
    seen.push(JSON.stringify(await s.getState()))
    for (const t of [...seen, ...logs]) expect(t).not.toContain(KEY)
  })
})
