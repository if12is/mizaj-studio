import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, parseError } from './client'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('api error parsing', () => {
  it('parses the error envelope', async () => {
    const e = await parseError(
      json(423, {
        error_code: 'ERR_DOCX_WRITE_LOCKED',
        message_ar: 'الملف مفتوح',
        message_en: 'locked',
        details: { a: 1 }
      })
    )
    expect(e).toBeInstanceOf(ApiError)
    expect(e.errorCode).toBe('ERR_DOCX_WRITE_LOCKED')
    expect(e.messageAr).toBe('الملف مفتوح')
    expect(e.status).toBe(423)
    expect(e.details).toEqual({ a: 1 })
  })

  it('falls back for non-envelope bodies', async () => {
    const e = await parseError(new Response('<html>', { status: 500 }))
    expect(e.errorCode).toBe('ERR_UNKNOWN')
    expect(e.messageAr).toContain('خطأ')
  })

  it('client calls onError with message_ar and throws', async () => {
    const onError = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const fetchImpl = vi.fn(async (_url: string) =>
      json(409, {
        error_code: 'ERR_DUPLICATE_WORD',
        message_ar: 'مكررة',
        message_en: 'dup',
        details: {}
      })
    )
    const c = new ApiClient({
      getBaseUrl: () => 'http://127.0.0.1:1',
      fetchImpl: fetchImpl as never,
      onError
    })
    await expect(c.post('/api/dictionary', { a: 1 })).rejects.toMatchObject({
      errorCode: 'ERR_DUPLICATE_WORD'
    })
    expect(onError.mock.calls[0][0].messageAr).toBe('مكررة')
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:1/api/dictionary')
  })

  it('handles 204 and missing backend', async () => {
    const c = new ApiClient({
      getBaseUrl: () => 'http://x',
      fetchImpl: (async () => new Response(null, { status: 204 })) as never
    })
    await expect(c.del('/api/projects/1')).resolves.toBeUndefined()
    const n = new ApiClient({ getBaseUrl: () => null })
    await expect(n.get('/health')).rejects.toMatchObject({ errorCode: 'ERR_BACKEND_UNAVAILABLE' })
  })
})
