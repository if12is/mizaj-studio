import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BASE, userContent } from './api'
import { CACHE_MIN_CHARS, CacheSupport, cacheValid, ensureCache } from './cache'
import { GeminiConfigStore } from './config'
import { GeminiKeyStore } from './keyStore'
import { GeminiService } from './service'
import { SessionStore, type ChatSession } from './sessions'

const KEY = 'AIzaSyDUMMYKEYFORTESTS1234567890abcd'
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s).reverse(),
  decryptString: (b: Buffer) => Buffer.from(b).reverse().toString()
}

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

let dir: string
let calls: Call[]
/** per-endpoint scripted behaviour */
let genStatus: number[] // consumed per generateContent call; missing = 200
let cacheStatus: number
let finish: string
let n: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-chat-'))
  calls = []
  genStatus = []
  cacheStatus = 200
  finish = 'STOP'
  n = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fakeFetch = (async (url: string, init: RequestInit) => {
  const body = init.body ? JSON.parse(String(init.body)) : {}
  calls.push({
    method: String(init.method),
    url,
    headers: init.headers as Record<string, string>,
    body
  })
  if (url.includes('/cachedContents') && init.method === 'POST') {
    if (cacheStatus !== 200)
      return new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), {
        status: cacheStatus
      })
    return new Response(JSON.stringify({ name: `cachedContents/c${++n}` }), { status: 200 })
  }
  if (init.method === 'DELETE') return new Response('{}', { status: 200 })
  const st = genStatus.shift() ?? 200
  if (st !== 200)
    return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'gone' } }), {
      status: st
    })
  return new Response(
    JSON.stringify({
      candidates: [{ finishReason: finish, content: { parts: [{ text: `جواب ${++n}` }] } }]
    }),
    { status: 200 }
  )
}) as unknown as typeof fetch

function svc(): GeminiService {
  const s = new GeminiService({
    keys: new GeminiKeyStore(join(dir, 'k.bin'), storage),
    config: new GeminiConfigStore(join(dir, 'c.json')),
    base: DEFAULT_BASE,
    sessions: new SessionStore(join(dir, 'sessions')),
    fetch: fakeFetch,
    sleep: async () => {}
  })
  new GeminiKeyStore(join(dir, 'k.bin'), storage).save(KEY)
  s.setConfig({ enabled: true, model: 'gemini-2.5-flash' })
  s.acceptConsent()
  return s
}

const gens = (): Call[] => calls.filter((c) => c.url.includes(':streamGenerateContent'))
const creates = (): Call[] => calls.filter((c) => c.url.endsWith('/cachedContents'))
const SMALL = 'نص قصير للمستند'
const BIG = 'كلمة '.repeat(CACHE_MIN_CHARS / 4)
const ask = (s: GeminiService, text: string, question: string, docId = 1, extra = {}) =>
  s.ask({ kind: 'document', question, text, docId, ...extra })

describe('per-document chat session', () => {
  it('puts the document once, first, in a stable prefix, and follow-ups continue the chat', async () => {
    const s = svc()
    await ask(s, SMALL, 'السؤال الأول')
    await ask(s, SMALL, 'السؤال الثاني')
    const [g1, g2] = gens()
    // first call: doc is the very first content, rules are the system instruction
    expect(g1.body.contents[0].parts[0].text).toContain(SMALL)
    expect(g1.body.systemInstruction.parts[0].text.length).toBeGreaterThan(50)
    // second call: identical prefix, then the previous Q/A, then the new question
    expect(g2.body.systemInstruction).toEqual(g1.body.systemInstruction)
    expect(g2.body.contents[0]).toEqual(g1.body.contents[0])
    expect(g2.body.contents[1]).toEqual(g1.body.contents[1])
    const texts = g2.body.contents.map((c: { parts: { text: string }[] }) => c.parts[0].text)
    expect(texts.filter((t: string) => t.includes(SMALL))).toHaveLength(1)
    expect(texts[2]).toContain('السؤال الأول')
    expect(texts[3]).toBe('جواب 1')
    expect(texts[4]).toContain('السؤال الثاني')
    expect(g2.body.contents.map((c: { role: string }) => c.role)).toEqual([
      'user',
      'model',
      'user',
      'model',
      'user'
    ])
  })

  it('persists across restarts and exposes the history to the panel', async () => {
    await ask(svc(), SMALL, 'س١')
    const r = svc().getSession(1, SMALL)
    expect(r).toMatchObject({
      ok: true,
      session: { stale: false, messages: [{ q: 'س١', scope: 'doc', answer: 'جواب 1' }] }
    })
    // another document has its own conversation
    expect(svc().getSession(2, SMALL)).toMatchObject({ ok: true, session: { messages: [] } })
  })

  it('«محادثة جديدة» clears history and deletes the remote cache', async () => {
    const s = svc()
    await ask(s, BIG, 'س')
    expect(creates()).toHaveLength(1)
    expect(await s.resetSession(1)).toEqual({ ok: true })
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/cachedContents/c1'))).toBe(
      true
    )
    expect(s.getSession(1, BIG)).toMatchObject({ session: { messages: [] } })
    await ask(s, BIG, 'س')
    expect(gens().at(-1)!.body.contents).toHaveLength(1) // fresh chat: only the new question
  })

  it('reports a refreshed context once when the document text changes', async () => {
    const s = svc()
    const a = await ask(s, SMALL, 'س١')
    expect(a).toMatchObject({ ok: true, result: { contextRefreshed: false } })
    expect(s.getSession(1, SMALL + ' تعديل')).toMatchObject({ session: { stale: true } })
    const b = await ask(s, SMALL + ' تعديل', 'س٢')
    expect(b).toMatchObject({ ok: true, result: { contextRefreshed: true } })
    // the new text replaced the old one in the prefix; the conversation continues
    const body = gens().at(-1)!.body.contents
    expect(body[0].parts[0].text).toContain('تعديل')
    expect(body).toHaveLength(5)
    const c = await ask(s, SMALL + ' تعديل', 'س٣')
    expect(c).toMatchObject({ ok: true, result: { contextRefreshed: false } })
  })

  it('selection questions join the same session and keep the suggestion rules', async () => {
    const s = svc()
    await ask(s, SMALL, 'س١')
    await s.ask({
      kind: 'selection',
      question: 'ما إعرابها؟',
      text: 'كتب',
      docId: 1,
      docText: SMALL
    })
    const last = gens().at(-1)!.body.contents.at(-1).parts[0].text as string
    expect(last).toContain('mizaj-suggestion')
    expect(last).toContain('كتب')
    expect(gens().at(-1)!.body.contents).toHaveLength(5)
  })

  it('MAX_TOKENS continuation appends to the stored answer without resending the document', async () => {
    const s = svc()
    finish = 'MAX_TOKENS'
    const first = await ask(s, SMALL, 'س')
    expect(first).toMatchObject({ ok: true, result: { cutoff: true, text: 'جواب 1' } })
    finish = 'STOP'
    const more = await ask(s, SMALL, 'س', 1, { continueFrom: 'جواب 1' })
    expect(more).toMatchObject({ ok: true, result: { text: 'جواب 2', cutoff: false } })
    const g = gens().at(-1)!.body.contents
    expect(g.map((c: { parts: { text: string }[] }) => c.parts[0].text).join('')).toContain(
      'تابع الإجابة'
    )
    expect(s.getSession(1, SMALL)).toMatchObject({
      session: { messages: [{ answer: 'جواب 1 جواب 2' }] }
    })
  })

  it('surfaces 429 with the retry delay and leaves the history untouched', async () => {
    const s = svc()
    genStatus = [429]
    const r = await ask(s, SMALL, 'س')
    expect(r).toMatchObject({ ok: false, code: 'quota' })
    expect(s.getSession(1, SMALL)).toMatchObject({ session: { messages: [] } })
  })

  it('never puts the key in the URL or body', async () => {
    const s = svc()
    await ask(s, BIG, 'س')
    for (const c of calls) {
      expect(c.url + JSON.stringify(c.body)).not.toContain(KEY)
      if (c.method !== 'DELETE') expect(c.headers['x-goog-api-key']).toBe(KEY)
    }
  })
})

describe('explicit context caching', () => {
  it('skips the cache for small documents (implicit caching only)', async () => {
    const s = svc()
    const r = await ask(s, SMALL, 'س')
    expect(creates()).toHaveLength(0)
    expect(r).toMatchObject({ result: { context: 'inline' } })
  })

  it('creates one cache for a large document with ttl ~1h and reuses it', async () => {
    const s = svc()
    const r1 = await ask(s, BIG, 'س١')
    const r2 = await ask(s, BIG, 'س٢')
    expect(creates()).toHaveLength(1)
    const c = creates()[0].body
    expect(c.model).toBe('models/gemini-2.5-flash')
    expect(c.ttl).toBe('3600s')
    expect(c.contents[0].parts[0].text).toContain('كلمة')
    expect(c.systemInstruction).toBeDefined()
    for (const g of gens()) {
      expect(g.body.cachedContent).toBe('cachedContents/c1')
      expect(g.body.systemInstruction).toBeUndefined() // lives in the cache
    }
    // the document is not resent: only history + the new question
    expect(gens()[0].body.contents).toHaveLength(1)
    expect(gens()[1].body.contents).toHaveLength(3)
    expect(r1).toMatchObject({ result: { context: 'explicit' } })
    expect(r2).toMatchObject({ result: { context: 'explicit' } })
  })

  it('recreates the cache when it is gone (404) and retries once', async () => {
    const s = svc()
    await ask(s, BIG, 'س١')
    genStatus = [404]
    const r = await ask(s, BIG, 'س٢')
    expect(r).toMatchObject({ ok: true, result: { context: 'explicit' } })
    expect(creates()).toHaveLength(2)
    expect(gens().at(-1)!.body.cachedContent).toBe('cachedContents/c3')
  })

  it('falls back to inline when recreation also fails', async () => {
    const s = svc()
    await ask(s, BIG, 'س١')
    genStatus = [404, 404]
    const r = await ask(s, BIG, 'س٢')
    expect(r).toMatchObject({ ok: true, result: { context: 'inline' } })
    const last = gens().at(-1)!.body
    expect(last.cachedContent).toBeUndefined()
    expect(last.systemInstruction).toBeDefined()
    expect(last.contents[0].parts[0].text).toContain('كلمة')
  })

  it('degrades gracefully when the model or tier does not support caching, and stops retrying', async () => {
    const s = svc()
    cacheStatus = 400
    const r1 = await ask(s, BIG, 'س١')
    const r2 = await ask(s, BIG, 'س٢')
    expect(r1).toMatchObject({ ok: true, result: { context: 'inline' } })
    expect(r2).toMatchObject({ ok: true })
    expect(creates()).toHaveLength(1) // not retried for this model
  })

  it('drops the cache when the document changes', async () => {
    const s = svc()
    await ask(s, BIG, 'س١')
    await ask(s, BIG + ' زيادة', 'س٢')
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true)
    expect(creates()).toHaveLength(2)
    expect(creates()[1].body.contents[0].parts[0].text).toContain('زيادة')
  })
})

describe('ensureCache (pure logic)', () => {
  const base = (): ChatSession => ({ docId: 1, hash: 'h', history: [], cache: null, updatedAt: 0 })
  const args = (session: ChatSession, over = {}) => ({
    f: fakeFetch,
    base: DEFAULT_BASE,
    key: KEY,
    model: 'm1',
    system: 's',
    prefix: [userContent('d')],
    docChars: CACHE_MIN_CHARS,
    session,
    support: new CacheSupport(),
    ...over
  })

  it('cacheValid honours model and expiry', () => {
    const c = { name: 'cachedContents/a', model: 'm1', expiresAt: 1000 }
    expect(cacheValid(c, 'm1', 999)).toBe(true)
    expect(cacheValid(c, 'm1', 1000)).toBe(false) // expired
    expect(cacheValid(c, 'm2', 1)).toBe(false) // other model
    expect(cacheValid(null, 'm1', 1)).toBe(false)
  })

  it('reuses a live cache and recreates an expired one', async () => {
    const s = base()
    let t = 1_000_000
    const now = () => t
    const a = await ensureCache(args(s, { now }))
    expect(a).toBe('cachedContents/c1')
    expect(await ensureCache(args(s, { now }))).toBe('cachedContents/c1')
    expect(creates()).toHaveLength(1)
    t += 3600 * 1000 // past ttl
    expect(await ensureCache(args(s, { now }))).toBe('cachedContents/c2')
    expect(creates()).toHaveLength(2)
  })

  it('does nothing below the size threshold', async () => {
    expect(await ensureCache(args(base(), { docChars: CACHE_MIN_CHARS - 1 }))).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('returns null (no throw) on 403/404/429 on create and marks the model unsupported', async () => {
    for (const st of [403, 404, 429]) {
      calls = []
      cacheStatus = st
      const support = new CacheSupport()
      expect(await ensureCache(args(base(), { support }))).toBeNull()
      expect(support.ok('m1')).toBe(false)
      expect(await ensureCache(args(base(), { support }))).toBeNull()
      expect(creates()).toHaveLength(1)
    }
  })

  it('a transient failure does not disable caching', async () => {
    cacheStatus = 503
    const support = new CacheSupport()
    expect(await ensureCache(args(base(), { support }))).toBeNull()
    expect(support.ok('m1')).toBe(true)
  })
})
