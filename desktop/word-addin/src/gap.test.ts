import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { PipelineDeps, ProofreadItem } from '../../src/main/systemwide/pipeline'
import { processParagraphs } from '../../src/main/wordaddin/process'
import type { Api, OpId } from './api'
import { Runner } from './run'
import type { WordHost } from './types'

const require_ = createRequire(import.meta.url)
const { createFakeWord } = require_('../test/fakeOffice.cjs') as {
  createFakeWord: (spec: unknown) => {
    Word: WordHost
    getDoc: () => { t: string; fmt: Record<string, unknown> }[][]
    stats: { writeBatches: number }
  }
}

const B = { bold: true }
const BU = { bold: true, underline: 'Single' }
const U = { underline: 'Single' }

const noTashkeel = async (t: string): Promise<{ text: string }> => ({ text: t })
const punct: PipelineDeps = {
  proofread: async (text, cats) => {
    const items: ProofreadItem[] = []
    if (cats.includes('punctuation'))
      for (const m of text.matchAll(/[ \t]+(?=[،.])/g))
        items.push({
          start: m.index ?? 0,
          end: (m.index ?? 0) + m[0].length,
          original: m[0],
          replacement: '',
          category: 'punctuation'
        })
    return { items }
  },
  apply: async (text, items) => {
    let out = text
    for (const it of [...items].sort((a, b) => b.start - a.start))
      out = out.slice(0, it.start) + it.replacement + out.slice(it.end)
    return { text: out, applied: items.length, skipped: 0 }
  },
  tashkeel: noTashkeel
}
const api = (deps: PipelineDeps): Api => ({
  ping: async () => ({ engine: true }),
  process: async (op: OpId, paragraphs: string[]) => processParagraphs({ op, paragraphs }, deps)
})
const flat = (g: () => { t: string }[][]): string[] => g().map((p) => p.map((r) => r.t).join(''))

const paragraphs = () => [
  {
    runs: [
      { t: 'قَضَتِ\tالْمَحْكَمَةُ  ', fmt: BU },
      { t: '، وَأَلْزَمَتْ \t', fmt: {} },
      { t: '.', fmt: U }
    ]
  },
  { runs: [{ t: 'ثُمَّ  ، انتهى', fmt: B }] }
]

function make(deps: PipelineDeps, spec: Record<string, unknown>) {
  const ps = paragraphs()
  const fake = createFakeWord({
    ...spec,
    paragraphs: ps,
    selection: { from: { p: 0, c: 0 }, to: { p: 1, c: ps[1].runs[0].t.length } }
  })
  return { fake, runner: new Runner({ host: fake.Word, api: api(deps), supported: () => true }) }
}

// every plausible behaviour of Word's '?' search: single chars, letter+marks clusters, and either
// of them without whitespace
const MODES = [
  { name: 'single characters (old fake)', spec: {} },
  { name: 'clusters', spec: { clusterMarks: true } },
  {
    name: 'clusters, no whitespace returned',
    spec: { clusterMarks: true, skipWhitespaceInWildcard: true }
  },
  { name: 'single chars, no whitespace returned', spec: { skipWhitespaceInWildcard: true } }
]

describe.each(MODES)('Word returns $name', ({ spec }) => {
  it('punctuation removes «  ،» spaces, runs kept, one batch, verified', async () => {
    const { fake, runner } = make(punct, spec)
    const r = await runner.runDirect('punctuation')
    expect(r.outcome.report).toMatchObject({ edited: 2, unmapped: 0, verifyFailed: false })
    expect(r.outcome.diagnostics).toBeNull()
    expect(flat(fake.getDoc)).toEqual(['قَضَتِ\tالْمَحْكَمَةُ، وَأَلْزَمَتْ.', 'ثُمَّ، انتهى'])
    const doc = fake.getDoc()
    expect(doc[0].map((x) => x.fmt)).toEqual([BU, {}, U])
    expect(doc[0].map((x) => x.t)).toEqual(['قَضَتِ\tالْمَحْكَمَةُ', '، وَأَلْزَمَتْ', '.'])
    expect(doc[1]).toEqual([{ t: 'ثُمَّ، انتهى', fmt: B }])
    expect(fake.stats.writeBatches).toBe(1)
  })

  it('tashkeel keeps tabs, spaces and runs', async () => {
    const { fake, runner } = make(
      { ...punct, tashkeel: async (t) => ({ text: t.replace('انتهى', 'انتَهى') }) },
      spec
    )
    const r = await runner.runDirect('tashkeel')
    expect(r.outcome.report).toMatchObject({ edited: 1, unmapped: 0, verifyFailed: false })
    expect(flat(fake.getDoc)).toEqual([
      'قَضَتِ\tالْمَحْكَمَةُ  ، وَأَلْزَمَتْ \t.',
      'ثُمَّ  ، انتَهى'
    ])
    expect(fake.getDoc()[0].map((x) => x.fmt)).toEqual([BU, {}, U])
    expect(fake.stats.writeBatches).toBe(1)
  })

  it('«الكل»: punctuation + tashkeel, runs kept, one batch, verified', async () => {
    const { fake, runner } = make(
      { ...punct, tashkeel: async (t) => ({ text: t.replace('انتهى', 'انتَهى') }) },
      spec
    )
    const r = await runner.runDirect('all')
    expect(r.outcome.report).toMatchObject({ edited: 2, unmapped: 0, verifyFailed: false })
    expect(flat(fake.getDoc)).toEqual(['قَضَتِ\tالْمَحْكَمَةُ، وَأَلْزَمَتْ.', 'ثُمَّ، انتَهى'])
    expect(fake.getDoc()[0].map((x) => x.fmt)).toEqual([BU, {}, U])
    expect(fake.stats.writeBatches).toBe(1)
  })
})

describe('gaps at the paragraph edges', () => {
  it('leading and trailing skipped whitespace is deleted through gap ranges', async () => {
    const fake = createFakeWord({
      clusterMarks: true,
      skipWhitespaceInWildcard: true,
      paragraphs: [{ runs: [{ t: '  كتاب  ', fmt: B }] }],
      selection: { from: { p: 0, c: 0 }, to: { p: 0, c: 8 } }
    })
    const trim: Api = {
      ping: async () => ({ engine: true }),
      process: async () => ({
        ok: true,
        changed: true,
        edits: [
          [
            { start: 0, end: 2, insert: '' },
            { start: 6, end: 8, insert: '' }
          ]
        ],
        segments: [],
        warnings: [],
        applied: { proofread: 0, punctuation: 0 },
        tashkeelRan: false
      })
    }
    const runner = new Runner({ host: fake.Word, api: trim, supported: () => true })
    const r = await runner.runDirect('punctuation')
    expect(r.outcome.report).toMatchObject({ edited: 1, unmapped: 0, verifyFailed: false })
    expect(fake.getDoc()).toEqual([[{ t: 'كتاب', fmt: B }]])
  })
})

describe('diagnostics when Word returns something unexpected', () => {
  it('reports a code with code points only, copyable JSON, writes nothing', async () => {
    const fake = createFakeWord({
      dropChars: 'ت', // Word silently drops a LETTER: not a skippable character
      paragraphs: [{ runs: [{ t: 'كتاب  ،', fmt: B }] }],
      selection: { from: { p: 0, c: 0 }, to: { p: 0, c: 7 } }
    })
    const runner = new Runner({ host: fake.Word, api: api(punct), supported: () => true })
    const r = await runner.runDirect('punctuation')
    expect(r.outcome.report).toMatchObject({ edited: 0, unmapped: 1 })
    expect(flat(fake.getDoc)).toEqual(['كتاب  ،'])
    expect(fake.stats.writeBatches).toBe(0)
    const msg = r.outcome.messages.join(' ')
    expect(msg).toContain('رمز: map-mismatch len=7 got=')
    expect(msg).toContain('U+062A')
    const d = r.outcome.diagnostics
    expect(d?.kind).toBe('map')
    const json = JSON.stringify(d)
    expect(json).not.toContain('كتاب')
    expect(json).toContain('U+0020')
  })
})
