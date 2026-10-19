import { describe, expect, it, vi } from 'vitest'
import { BackendError, createBackendDeps } from './backend'
import {
  MAX_SELECTION_CHARS,
  PipelineError,
  SHORT_TEXT_WORDS,
  runOp,
  type PipelineDeps,
  type ProofreadCategory,
  type ProofreadItem
} from './pipeline'

/** A small deterministic fake of the backend: replaces fixed words per category. */
function fake(rules: { cat: ProofreadCategory; from: string; to: string }[]): PipelineDeps & {
  calls: { proofread: ProofreadCategory[][]; tashkeel: string[] }
} {
  const calls = { proofread: [] as ProofreadCategory[][], tashkeel: [] as string[] }
  return {
    calls,
    async proofread(text, categories) {
      calls.proofread.push([...categories])
      const items: ProofreadItem[] = []
      // the fake is deliberately sloppy: it returns items of ALL categories
      for (const r of rules) {
        let i = text.indexOf(r.from)
        while (i >= 0) {
          items.push({
            start: i,
            end: i + r.from.length,
            original: r.from,
            replacement: r.to,
            category: r.cat
          })
          i = text.indexOf(r.from, i + 1)
        }
      }
      return { items }
    },
    async apply(text, items) {
      let out = text
      let applied = 0
      for (const it of [...items].sort((a, b) => b.start - a.start)) {
        if (out.slice(it.start, it.end) !== it.original) continue
        out = out.slice(0, it.start) + it.replacement + out.slice(it.end)
        applied++
      }
      return { text: out, applied, skipped: items.length - applied }
    },
    async tashkeel(text) {
      calls.tashkeel.push(text)
      return { text: text.replace(/كتاب/g, 'كِتَابٌ').replace(/أبو/g, 'أَبُو') }
    }
  }
}

const RULES = [
  { cat: 'hamza' as const, from: 'ابو', to: 'أبو' },
  { cat: 'ya' as const, from: 'فى', to: 'في' },
  { cat: 'punctuation' as const, from: ' ،', to: '،' }
]
const TEXT = 'قال ابو زيد فى الكتاب ،وعاد'

describe('runOp: operations and category filters', () => {
  it('proofread applies hamza/spelling/ya only (never punctuation) and no tashkeel', async () => {
    const d = fake(RULES)
    const r = await runOp('proofread', TEXT, d)
    expect(r.text).toBe('قال أبو زيد في الكتاب ،وعاد')
    expect(d.calls.proofread).toEqual([['hamza', 'spelling', 'ya']])
    expect(d.calls.tashkeel).toEqual([])
    expect(r.applied).toEqual({ proofread: 2, punctuation: 0 })
  })

  it('punctuation applies punctuation only (never letters) and no tashkeel', async () => {
    const d = fake(RULES)
    const r = await runOp('punctuation', TEXT, d)
    expect(r.text).toBe('قال ابو زيد فى الكتاب،وعاد')
    expect(d.calls.proofread).toEqual([['punctuation']])
    expect(d.calls.tashkeel).toEqual([])
  })

  it('tashkeel only adds marks and runs no proofreading', async () => {
    const d = fake(RULES)
    const r = await runOp('tashkeel', 'هذا كتاب جميل جدا', d)
    expect(r.text).toBe('هذا كِتَابٌ جميل جدا')
    expect(d.calls.proofread).toEqual([])
    expect(r.tashkeelRan).toBe(true)
  })

  it('all = proofread, then punctuation, then tashkeel, in that order, each on the previous result', async () => {
    const d = fake(RULES)
    const r = await runOp('all', TEXT, d)
    expect(d.calls.proofread).toEqual([['hamza', 'spelling', 'ya'], ['punctuation']])
    expect(d.calls.tashkeel).toEqual(['قال أبو زيد في الكتاب،وعاد']) // tashkeel saw the corrected text
    expect(r.text).toBe('قال أَبُو زيد في الكِتَابٌ،وعاد')
    expect(r.applied).toEqual({ proofread: 2, punctuation: 1 })
  })

  it('applies nothing when the backend finds nothing', async () => {
    const d = fake([])
    const r = await runOp('proofread', 'كلمة سليمة هنا اليوم', d)
    expect(r.text).toBe('كلمة سليمة هنا اليوم')
  })
})

describe('runOp: safety', () => {
  it('rejects a tashkeel result that changed a base letter, and says so', async () => {
    const d = fake([])
    d.tashkeel = async () => ({ text: 'هذا كُتُب جميل جدا' })
    const r = await runOp('tashkeel', 'هذا كتاب جميل جدا', d)
    expect(r.text).toBe('هذا كتاب جميل جدا')
    expect(r.warnings).toContain('tashkeel_base_changed')
    expect(r.tashkeelRan).toBe(false)
  })

  it('in "all" a refused tashkeel still keeps the proofreading result', async () => {
    const d = fake(RULES)
    d.tashkeel = async () => ({ text: 'x' })
    const r = await runOp('all', TEXT, d)
    expect(r.text).toBe('قال أبو زيد في الكتاب،وعاد')
    expect(r.warnings).toContain('tashkeel_base_changed')
  })

  it('reports stale items instead of forcing them', async () => {
    const d = fake(RULES)
    const orig = d.apply
    d.apply = async (t, items) => ({ ...(await orig(t, items)), skipped: 1 })
    const r = await runOp('proofread', TEXT, d)
    expect(r.warnings).toContain('stale_items')
  })

  it('short text warns for tashkeel and all, never for proofread/punctuation', async () => {
    expect(SHORT_TEXT_WORDS).toBe(4)
    const d = fake([])
    expect((await runOp('tashkeel', 'كتاب جميل', d)).warnings).toContain('short_text')
    expect((await runOp('all', 'كتاب جميل جدا', d)).warnings).toContain('short_text')
    expect((await runOp('proofread', 'كتاب جميل', d)).warnings).not.toContain('short_text')
    expect((await runOp('punctuation', 'كتاب جميل', d)).warnings).not.toContain('short_text')
    expect((await runOp('tashkeel', 'هذا كتاب جميل جدا', d)).warnings).not.toContain('short_text')
  })

  it('refuses empty, non-Arabic and over-long selections', async () => {
    const d = fake([])
    await expect(runOp('all', '   \n', d)).rejects.toMatchObject({ code: 'empty' })
    await expect(runOp('all', 'hello world', d)).rejects.toMatchObject({ code: 'no_arabic' })
    await expect(runOp('all', 'ا'.repeat(MAX_SELECTION_CHARS + 1), d)).rejects.toBeInstanceOf(
      PipelineError
    )
    expect(d.calls.proofread).toEqual([])
  })
})

describe('createBackendDeps', () => {
  const target = { baseUrl: 'http://127.0.0.1:5555', token: 'tok-secret' }
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('sends the token header, categories filter, and reuses /apply', async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith('/api/proofread')
        ? json({
            items: [
              { start: 0, end: 3, original: 'ابو', replacement: 'أبو', category: 'hamza', extra: 1 }
            ]
          })
        : json({ text: 'أبو', applied: 1, skipped: [] })
    )
    const d = createBackendDeps(() => target, f as never)
    const { items } = await d.proofread('ابو', ['hamza', 'spelling', 'ya'])
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:5555/api/proofread')
    expect((init.headers as Record<string, string>)['X-Mizaj-Token']).toBe('tok-secret')
    expect(JSON.parse(init.body as string)).toMatchObject({
      text: 'ابو',
      categories: ['hamza', 'spelling', 'ya']
    })
    const r = await d.apply('ابو', items)
    expect(r).toEqual({ text: 'أبو', applied: 1, skipped: 0 })
    const applyBody = JSON.parse(
      (f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string
    )
    expect(Object.keys(applyBody.items[0]).sort()).toEqual([
      'end',
      'original',
      'replacement',
      'start'
    ])
    expect((f.mock.calls[1] as unknown as [string])[0]).toContain('/api/proofread/apply')
  })

  it('tashkeel uses the saved engine and level and protects Quran spans', async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith('/api/settings')
        ? json({ engine_mode: 'accurate', tashkeel_level: 'essential' })
        : json({ text: 'كِتَاب' })
    )
    const r = await createBackendDeps(() => target, f as never).tashkeel('كتاب')
    expect(r.text).toBe('كِتَاب')
    const body = JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toMatchObject({
      mode: 'accurate',
      level: 'essential',
      keep_existing: true,
      protect_quran: true
    })
  })

  it('falls back to safe defaults for odd settings values', async () => {
    const f = vi.fn(async (url: string) =>
      url.endsWith('/api/settings')
        ? json({ engine_mode: 'x', tashkeel_level: '?' })
        : json({ text: 'a' })
    )
    await createBackendDeps(() => target, f as never).tashkeel('كتاب')
    const body = JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toMatchObject({ mode: 'fast', level: 'full' })
  })

  it('maps backend error envelopes, offline backend and timeouts to Arabic errors', async () => {
    const env = createBackendDeps(() => target, (async () =>
      json({ error_code: 'ERR_X', message_ar: 'رسالة' }, 500)) as never)
    await expect(env.tashkeel('ك')).rejects.toMatchObject({ code: 'ERR_X', messageAr: 'رسالة' })
    const down = createBackendDeps(() => target, (async () => {
      throw new TypeError('fetch failed')
    }) as never)
    await expect(down.proofread('ك', ['hamza'])).rejects.toMatchObject({
      code: 'ERR_BACKEND_UNAVAILABLE'
    })
    const none = createBackendDeps(() => ({ baseUrl: null, token: 't' }), (async () =>
      json({})) as never)
    await expect(none.proofread('ك', ['hamza'])).rejects.toBeInstanceOf(BackendError)
  })
})
