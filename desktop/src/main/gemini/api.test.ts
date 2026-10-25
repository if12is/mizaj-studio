import { describe, expect, it } from 'vitest'
import {
  assertAllowedUrl,
  DEFAULT_BASE,
  generate,
  listModels,
  parseModels,
  parseRetryDelay,
  pickDefaultModel,
  resolveBase,
  sortModels
} from './api'
import { GeminiError } from './errors'

const KEY = 'AIzaSyDUMMYKEYFORTESTS1234567890abcd'
const M = (name: string, methods = ['generateContent']) => ({
  name: `models/${name}`,
  displayName: name,
  supportedGenerationMethods: methods
})

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string, init: RequestInit) => {
    seen.url = url
    seen.init = init
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
}

describe('base URL and allowlist', () => {
  it('ignores the test override unless explicitly allowed', () => {
    const env = { MIZAJ_GEMINI_BASE_URL: 'http://127.0.0.1:5555' }
    expect(resolveBase(env, false)).toBe(DEFAULT_BASE)
    expect(resolveBase(env, true)).toBe('http://127.0.0.1:5555')
  })
  it('the override must still be loopback', () => {
    expect(resolveBase({ MIZAJ_GEMINI_BASE_URL: 'https://evil.example' }, true)).toBe(DEFAULT_BASE)
  })
  it('only https on generativelanguage.googleapis.com is allowed by default', () => {
    expect(() => assertAllowedUrl(`${DEFAULT_BASE}/v1beta/models`, DEFAULT_BASE)).not.toThrow()
    for (const u of [
      'http://generativelanguage.googleapis.com/x',
      'https://generativelanguage.googleapis.com.evil.com/x',
      'https://evil.com/x',
      'https://u:p@generativelanguage.googleapis.com/x',
      'https://generativelanguage.googleapis.com:8443/x'
    ])
      expect(() => assertAllowedUrl(u, DEFAULT_BASE), u).toThrow(GeminiError)
  })
})

describe('model list', () => {
  const list = {
    models: [
      M('gemini-1.5-pro'),
      M('gemini-2.5-flash'),
      M('gemini-2.5-flash-lite'),
      M('gemini-2.0-flash'),
      M('gemini-2.5-pro'),
      M('text-embedding-004', ['embedContent']),
      M('gemini-2.5-flash-preview-tts'),
      M('gemma-3-27b-it', ['generateContent'])
    ]
  }
  it('keeps generateContent models only, newest first', () => {
    const ids = parseModels(list).map((m) => m.id)
    expect(ids).not.toContain('text-embedding-004')
    expect(ids).not.toContain('gemini-2.5-flash-preview-tts')
    expect(ids.indexOf('gemini-2.5-pro')).toBeLessThan(ids.indexOf('gemini-2.0-flash'))
    expect(ids.indexOf('gemini-2.0-flash')).toBeLessThan(ids.indexOf('gemini-1.5-pro'))
  })
  it('preselects the newest flash (not lite)', () => {
    expect(pickDefaultModel(parseModels(list))).toBe('gemini-2.5-flash')
  })
  it('falls back to the first model when there is no flash', () => {
    expect(pickDefaultModel(sortModels([{ id: 'gemini-2.5-pro', display: '' }]))).toBe(
      'gemini-2.5-pro'
    )
  })
  it('sends the key only in the x-goog-api-key header', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const models = await listModels(fakeFetch(200, list, seen), DEFAULT_BASE, KEY)
    expect(models.length).toBeGreaterThan(0)
    expect(seen.url).not.toContain(KEY)
    expect((seen.init!.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY)
  })
})

describe('generate and error mapping', () => {
  const ok = { candidates: [{ content: { parts: [{ text: 'الجواب' }] }, finishReason: 'STOP' }] }
  it('returns the text', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    expect(
      await generate(fakeFetch(200, ok, seen), DEFAULT_BASE, KEY, 'gemini-2.5-flash', 'sys', 'q')
    ).toMatchObject({ text: 'الجواب', cutoff: false })
    expect(seen.url).toContain('gemini-2.5-flash:streamGenerateContent')
    expect(JSON.stringify(seen.init!.body)).not.toContain(KEY)
  })
  const code = async (f: typeof fetch): Promise<string> => {
    try {
      await generate(f, DEFAULT_BASE, KEY, 'gemini-2.5-flash', 's', 'q')
    } catch (e) {
      return (e as GeminiError).code
    }
    return 'none'
  }
  it('maps invalid key, quota, safety, offline and timeout', async () => {
    expect(
      await code(
        fakeFetch(400, { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid' } })
      )
    ).toBe('invalid_key')
    expect(await code(fakeFetch(403, { error: { status: 'PERMISSION_DENIED' } }))).toBe(
      'invalid_key'
    )
    expect(await code(fakeFetch(429, { error: { status: 'RESOURCE_EXHAUSTED' } }))).toBe('quota')
    expect(await code(fakeFetch(200, { promptFeedback: { blockReason: 'SAFETY' } }))).toBe('safety')
    expect(await code(fakeFetch(200, { candidates: [{ finishReason: 'SAFETY' }] }))).toBe('safety')
    expect(
      await code((async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch)
    ).toBe('offline')
  })
  it('error messages are Arabic and never contain the key', async () => {
    try {
      await generate(
        fakeFetch(403, { error: { message: KEY } }),
        DEFAULT_BASE,
        KEY,
        'gemini-2.5-flash',
        's',
        'q'
      )
    } catch (e) {
      expect((e as Error).message).toMatch(/[\u0600-\u06FF]/)
      expect((e as Error).message).not.toContain(KEY)
    }
  })
  it('rejects a malformed model id', async () => {
    await expect(
      generate(fakeFetch(200, ok), DEFAULT_BASE, KEY, '../x?y', 's', 'q')
    ).rejects.toBeInstanceOf(GeminiError)
  })
})

describe('generate: output budget, thoughts, finish reasons', () => {
  const resp = (parts: unknown[], finishReason = 'STOP') => ({
    candidates: [{ content: { parts }, finishReason }]
  })
  const gen = (f: typeof fetch, model = 'gemini-2.5-flash', o = {}) =>
    generate(f, DEFAULT_BASE, KEY, model, 's', 'q', { sleep: async () => undefined, ...o })

  it('requests a large output budget and a modest thinking budget', async () => {
    const seen: { init?: RequestInit } = {}
    await gen(fakeFetch(200, resp([{ text: 'a' }]), seen))
    const body = JSON.parse(seen.init!.body as string)
    expect(body.generationConfig.maxOutputTokens).toBe(8192)
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0)
    const seen2: { init?: RequestInit } = {}
    await gen(fakeFetch(200, resp([{ text: 'a' }]), seen2), 'gemini-2.0-flash', {
      outputTokenLimit: 4000
    })
    const b2 = JSON.parse(seen2.init!.body as string)
    expect(b2.generationConfig.maxOutputTokens).toBe(4000)
    expect(b2.generationConfig.thinkingConfig).toBeUndefined()
  })
  it('concatenates all text parts and skips thoughts', async () => {
    const r = await gen(
      fakeFetch(200, resp([{ text: 'تفكير', thought: true }, { text: 'أ' }, { text: 'ب' }]))
    )
    expect(r.text).toBe('أب')
  })
  it('MAX_TOKENS keeps the partial answer and flags cutoff; empty is a clear error', async () => {
    expect(await gen(fakeFetch(200, resp([{ text: 'جزء' }], 'MAX_TOKENS')))).toMatchObject({
      text: 'جزء',
      cutoff: true
    })
    await expect(gen(fakeFetch(200, resp([], 'MAX_TOKENS')))).rejects.toMatchObject({
      code: 'empty'
    })
  })
  it('maps RECITATION, OTHER and block reasons', async () => {
    await expect(gen(fakeFetch(200, resp([], 'RECITATION')))).rejects.toMatchObject({
      code: 'recitation'
    })
    await expect(gen(fakeFetch(200, resp([], 'OTHER')))).rejects.toMatchObject({
      code: 'blocked_other'
    })
    await expect(
      gen(fakeFetch(200, { promptFeedback: { blockReason: 'OTHER' } }))
    ).rejects.toMatchObject({ code: 'blocked_other' })
  })
  it('continuation sends the partial answer as a model turn', async () => {
    const seen: { init?: RequestInit } = {}
    await gen(fakeFetch(200, resp([{ text: 'x' }]), seen), 'gemini-2.5-flash', {
      continueFrom: 'بداية'
    })
    const c = JSON.parse(seen.init!.body as string).contents
    expect(c.map((x: { role: string }) => x.role)).toEqual(['user', 'model', 'user'])
    expect(c[1].parts[0].text).toBe('بداية')
  })
  it('parses model token limits', () => {
    const m = parseModels({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          supportedGenerationMethods: ['generateContent'],
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536
        }
      ]
    })
    expect(m[0]).toMatchObject({ inputTokenLimit: 1048576, outputTokenLimit: 65536 })
  })
})

describe('quota delay and 5xx backoff', () => {
  const q = (retryDelay: string) => ({
    error: {
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }]
    }
  })
  it('parses RetryInfo.retryDelay', () => {
    expect(parseRetryDelay(q('27s').error.details)).toBe(27)
    expect(parseRetryDelay(q('1.5s').error.details)).toBe(1.5)
    expect(parseRetryDelay(undefined, 'Please retry in 12.3s.')).toBe(12.3)
    expect(parseRetryDelay([], 'x')).toBeUndefined()
  })
  it('short waits carry retryAfterSec; long waits put the time and advice in the message', async () => {
    const short = await generate(
      fakeFetch(429, q('5s')),
      DEFAULT_BASE,
      KEY,
      'gemini-2.5-flash',
      's',
      'q'
    ).catch((e) => e)
    expect(short.retryAfterSec).toBe(5)
    const long = await generate(
      fakeFetch(429, q('90s')),
      DEFAULT_BASE,
      KEY,
      'gemini-2.5-flash',
      's',
      'q'
    ).catch((e) => e)
    expect(long.retryAfterSec).toBe(90)
    expect(long.message).toContain('90')
    expect(long.message).toContain('flash-lite')
    expect(long.message).toContain('flash-lite')
  })
  it('retries 503 twice with backoff, then succeeds', async () => {
    let n = 0
    const waits: number[] = []
    const f = (async () => {
      n++
      if (n < 3) return new Response('{}', { status: 503 })
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'تم' }] } }] }),
        { status: 200 }
      )
    }) as unknown as typeof fetch
    const r = await generate(f, DEFAULT_BASE, KEY, 'gemini-2.5-flash', 's', 'q', {
      sleep: async (ms) => void waits.push(ms)
    })
    expect(r.text).toBe('تم')
    expect(n).toBe(3)
    expect(waits).toEqual([1000, 3000])
  })
  it('gives up after two retries', async () => {
    let n = 0
    const f = (async () => {
      n++
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    await expect(
      generate(f, DEFAULT_BASE, KEY, 'gemini-2.5-flash', 's', 'q', { sleep: async () => undefined })
    ).rejects.toMatchObject({ code: 'bad_response' })
    expect(n).toBe(3)
  })
})
