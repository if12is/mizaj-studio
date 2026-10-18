import { describe, expect, it } from 'vitest'
import {
  assertAllowedUrl,
  DEFAULT_BASE,
  generate,
  listModels,
  parseModels,
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
    ).toBe('الجواب')
    expect(seen.url).toContain('gemini-2.5-flash:generateContent')
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
    expect(
      await code((async () => {
        throw Object.assign(new Error('t'), { name: 'TimeoutError' })
      }) as unknown as typeof fetch)
    ).toBe('timeout')
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
