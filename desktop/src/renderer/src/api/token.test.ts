import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './client'
import { streamTashkeel } from './sse'
import { getApiToken, setApiToken, TOKEN_HEADER, withToken } from './token'

afterEach(() => setApiToken(null))

describe('X-Mizaj-Token', () => {
  it('header name matches the backend contract', () => expect(TOKEN_HEADER).toBe('X-Mizaj-Token'))

  it('withToken adds the header only when a token is known', () => {
    expect(withToken({ a: 'b' }, null)).toEqual({ a: 'b' })
    expect(withToken(undefined, 't')).toEqual({ 'X-Mizaj-Token': 't' })
    expect(withToken({ a: 'b' }, 't')).toEqual({ a: 'b', 'X-Mizaj-Token': 't' })
    setApiToken('')
    expect(getApiToken()).toBeNull()
  })

  it('ApiClient sends it on GET (no body) and POST (body)', async () => {
    setApiToken('tok123')
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    const c = new ApiClient({ getBaseUrl: () => 'http://127.0.0.1:1', fetchImpl: f as never })
    await c.get('/api/settings')
    await c.post('/api/x', { a: 1 })
    const calls = f.mock.calls as unknown as [string, { headers: Record<string, string> }][]
    expect(calls[0][1].headers['X-Mizaj-Token']).toBe('tok123')
    expect(calls[1][1].headers['X-Mizaj-Token']).toBe('tok123')
    expect(calls[1][1].headers['Content-Type']).toBe('application/json')
  })

  it('SSE stream request carries it too, and never puts it in the URL', async () => {
    setApiToken('tok123')
    const f = vi.fn(async () => new Response('', { status: 500 }))
    for await (const m of streamTashkeel({ baseUrl: 'http://x', body: {}, fetchImpl: f as never }))
      void m
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(init.headers['X-Mizaj-Token']).toBe('tok123')
    expect(url).not.toContain('tok123')
  })
})
