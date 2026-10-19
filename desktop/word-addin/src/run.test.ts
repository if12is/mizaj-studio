import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { PipelineDeps, ProofreadItem } from '../../src/main/systemwide/pipeline'
import { processParagraphs } from '../../src/main/wordaddin/process'
import { AddinApiError, type Api, type OpId } from './api'
import { applyParagraphEdits } from './apply'
import { RunError, Runner } from './run'
import { readSelection } from './selection'
import type { WContext, WordHost } from './types'

const require_ = createRequire(import.meta.url)
const { createFakeWord } = require_('../test/fakeOffice.cjs') as {
  createFakeWord: (spec: unknown) => {
    Word: WordHost
    getDoc: () => { t: string; fmt: Record<string, unknown> }[][]
    stats: { writeBatches: number }
  }
}

const B = { bold: true }
const I = { italic: true }
const RED = { color: '#ff0000', size: 18 }

/** The mock-mode vowelizer (AGENTS.md): fatha on the first letter, damma on the last. */
const mockTashkeel = (t: string): string =>
  t.replace(/[ء-ي]+/g, (w) => w[0] + 'َ' + w.slice(1) + (w.length > 1 ? 'ُ' : ''))

const hamzaItems = (text: string): ProofreadItem[] => {
  const out: ProofreadItem[] = []
  for (const m of text.matchAll(/(^|\s)(انا)(?=\s|$)/g)) {
    const start = (m.index ?? 0) + m[1].length
    out.push({ start, end: start + 3, original: 'انا', replacement: 'أنا', category: 'hamza' })
  }
  return out
}
const engine: PipelineDeps = {
  proofread: async (text, cats) => ({
    items: cats.includes('hamza') ? hamzaItems(text) : []
  }),
  apply: async (text, items) => {
    let out = text
    for (const it of [...items].sort((a, b) => b.start - a.start))
      out = out.slice(0, it.start) + it.replacement + out.slice(it.end)
    return { text: out, applied: items.length, skipped: 0 }
  },
  tashkeel: async (t) => ({ text: mockTashkeel(t) })
}

/** The real server logic (process.ts) behind an in-memory Api. */
const api = (deps: PipelineDeps = engine): Api => ({
  ping: async () => ({ engine: true }),
  process: async (op: OpId, paragraphs: string[]) => {
    try {
      return await processParagraphs({ op, paragraphs }, deps)
    } catch (e) {
      throw new AddinApiError('rejected', (e as { messageAr?: string }).messageAr ?? 'x')
    }
  }
})

interface P {
  runs: { t: string; fmt?: Record<string, unknown> }[]
  table?: number
  fields?: number
  ccs?: number
}
function setup(paragraphs: P[], selection?: unknown) {
  const last = paragraphs.length - 1
  const fake = createFakeWord({
    paragraphs,
    selection: selection ?? {
      from: { p: 0, c: 0 },
      to: { p: last, c: paragraphs[last].runs.reduce((n, r) => n + r.t.length, 0) }
    }
  })
  const runner = new Runner({ host: fake.Word, api: api(), supported: () => true })
  return { fake, runner }
}
const flat = (doc: ReturnType<typeof setup>['fake']['getDoc']) =>
  doc().map((p) => p.map((r) => r.t).join(''))

describe('tashkeel keeps every formatting run', () => {
  const paragraphs: P[] = [
    {
      runs: [
        { t: 'كتاب ', fmt: B },
        { t: 'جميل ', fmt: {} },
        { t: 'جدا', fmt: RED }
      ]
    },
    {
      runs: [
        { t: 'قل', fmt: I },
        { t: 'م', fmt: B }
      ]
    }
  ]
  it('text is vowelized, runs and their properties are the same, one write batch', async () => {
    const { fake, runner } = setup(paragraphs)
    const r = await runner.runDirect('tashkeel')
    expect(r.outcome.report).toMatchObject({ edited: 2, unmapped: 0, verifyFailed: false })
    expect(flat(fake.getDoc)).toEqual([mockTashkeel('كتاب جميل جدا'), mockTashkeel('قلم')])
    const doc = fake.getDoc()
    // paragraph 1: three runs with the SAME formats, in the same order; spaces stay in their runs
    expect(doc[0].map((x) => x.fmt)).toEqual([B, {}, RED])
    expect(doc[0].map((x) => x.t)).toEqual([
      mockTashkeel('كتاب') + ' ',
      mockTashkeel('جميل') + ' ',
      mockTashkeel('جدا')
    ])
    // paragraph 2: the word is split across two runs and stays split
    expect(doc[1].map((x) => x.fmt)).toEqual([I, B])
    expect(doc[1].map((x) => x.t).join('')).toBe(mockTashkeel('قلم'))
    expect(doc[1][0].t).toBe('قَل')
    // everything went to Word in ONE batch (one Ctrl+Z)
    expect(fake.stats.writeBatches).toBe(1)
  })

  it('the preview does not write anything', async () => {
    const { fake, runner } = setup(paragraphs)
    const p = await runner.preview('tashkeel')
    expect(p.changed).toBe(true)
    expect(p.segments.some((s) => s.kind === 'change')).toBe(true)
    expect(fake.stats.writeBatches).toBe(0)
    expect(flat(fake.getDoc)).toEqual(['كتاب جميل جدا', 'قلم'])
  })

  it('a second run is a no-change', async () => {
    const { runner } = setup([{ runs: [{ t: 'كتاب', fmt: B }] }])
    await runner.runDirect('tashkeel')
    // the engine is deterministic and keeps existing marks: re-running adds nothing new to an already marked text
    const again = await new Runner({
      host: setup([{ runs: [{ t: 'كَتابُ', fmt: B }] }]).fake.Word,
      api: api({ ...engine, tashkeel: async (t) => ({ text: t }) }),
      supported: () => true
    }).preview('tashkeel')
    expect(again.changed).toBe(false)
  })
})

describe('letters (proofread) are replaced inside their run', () => {
  it('hamza fix keeps the bold run bold', async () => {
    const { fake, runner } = setup([
      {
        runs: [
          { t: 'انا ', fmt: B },
          { t: 'اكتب', fmt: {} }
        ]
      }
    ])
    const r = await runner.runDirect('proofread')
    expect(r.outcome.report.edited).toBe(1)
    const doc = fake.getDoc()
    expect(doc[0]).toEqual([
      { t: 'أنا ', fmt: B },
      { t: 'اكتب', fmt: {} }
    ])
  })
  it('"all" = proofread then tashkeel in one go', async () => {
    const { fake, runner } = setup([
      {
        runs: [
          { t: 'انا ', fmt: B },
          { t: 'كتاب', fmt: I }
        ]
      }
    ])
    await runner.runDirect('all')
    const doc = fake.getDoc()
    expect(doc[0].map((x) => x.fmt)).toEqual([B, I])
    expect(doc[0].map((x) => x.t).join('')).toBe(mockTashkeel('أنا كتاب'))
    expect(fake.stats.writeBatches).toBe(1)
  })
})

describe('partial selections', () => {
  it('only the selected part of the first and last paragraphs changes', async () => {
    const paragraphs: P[] = [
      {
        runs: [
          { t: 'كتاب ', fmt: B },
          { t: 'قلم', fmt: I }
        ]
      },
      {
        runs: [
          { t: 'باب ', fmt: B },
          { t: 'نافذة', fmt: I }
        ]
      }
    ]
    // from "قلم" (index 5) in paragraph 0 to the end of "باب" (index 3) in paragraph 1
    const { fake, runner } = setup(paragraphs, { from: { p: 0, c: 5 }, to: { p: 1, c: 3 } })
    await runner.runDirect('tashkeel')
    expect(flat(fake.getDoc)).toEqual([
      `كتاب ${mockTashkeel('قلم')}`,
      `${mockTashkeel('باب')} نافذة`
    ])
    expect(fake.getDoc()[0][0]).toEqual({ t: 'كتاب ', fmt: B })
    expect(fake.getDoc()[1][1].t).toBe('نافذة')
  })
})

describe('fields, content controls and tables are never corrupted', () => {
  const paragraphs: P[] = [
    { runs: [{ t: 'كتاب', fmt: B }] },
    {
      runs: [
        { t: 'صفحة ', fmt: {} },
        { t: '12', fmt: B }
      ],
      fields: 1
    },
    { runs: [{ t: 'اسم العميل', fmt: {} }], ccs: 1 },
    { runs: [{ t: 'خلية', fmt: I }], table: 1 }
  ]
  it('paragraphs with a field or a content control are left exactly as they are; table cells are edited', async () => {
    const { fake, runner } = setup(paragraphs)
    const before = fake.getDoc()
    const r = await runner.runDirect('tashkeel')
    const after = fake.getDoc()
    expect(after[1]).toEqual(before[1])
    expect(after[2]).toEqual(before[2])
    expect(after[0].map((x) => x.t).join('')).toBe(mockTashkeel('كتاب'))
    expect(after[3].map((x) => x.t).join('')).toBe(mockTashkeel('خلية'))
    expect(after[3][0].fmt).toEqual(I)
    expect(r.preview.skipped).toEqual({ field: 1, content_control: 1 })
    expect(r.outcome.messages.join(' ')).toContain('حقولاً')
    expect(r.outcome.messages.join(' ')).toContain('عناصر تحكم')
  })
  it('a selection made only of such paragraphs is refused with a clear message', async () => {
    const { runner } = setup([paragraphs[1], paragraphs[2]])
    await expect(runner.preview('tashkeel')).rejects.toMatchObject({ code: 'nothing' })
  })
})

describe('safety nets', () => {
  it('an insertion point (empty selection) is refused', async () => {
    const { runner } = setup([{ runs: [{ t: 'كتاب' }] }], {
      from: { p: 0, c: 2 },
      to: { p: 0, c: 2 }
    })
    await expect(runner.preview('tashkeel')).rejects.toMatchObject({ code: 'empty' })
  })
  it('the document changing between preview and replace aborts without writing', async () => {
    const { fake, runner } = setup([{ runs: [{ t: 'كتاب' }] }])
    const p = await runner.preview('tashkeel')
    // the user types while the preview is open
    await fake.Word.run(async (ctx) => {
      const sel = ctx.document.getSelection()
      const paras = sel.paragraphs
      paras.load('items')
      await ctx.sync()
      const chars = paras.items[0].getRange('Content').search('?', { matchWildcards: true })
      chars.load('items/text')
      await ctx.sync()
      chars.items[0].insertText('x', 'Replace')
    })
    await expect(runner.apply(p)).rejects.toBeInstanceOf(RunError)
    await expect(runner.apply(p)).rejects.toMatchObject({ code: 'stale' })
    expect(fake.getDoc()[0][0].t).toBe('xتاب')
  })
  it('an old Word without WordApi 1.4 is refused up front', async () => {
    const fake = createFakeWord({
      paragraphs: [{ runs: [{ t: 'كتاب' }] }],
      selection: { from: { p: 0, c: 0 }, to: { p: 0, c: 4 } }
    })
    const runner = new Runner({ host: fake.Word, api: api(), supported: () => false })
    await expect(runner.preview('tashkeel')).rejects.toMatchObject({ code: 'unsupported' })
  })
  it('a tashkeel answer that changes base letters is rejected client-side too', async () => {
    const evil: Api = {
      ping: async () => ({ engine: true }),
      process: async () => ({
        ok: true,
        changed: true,
        edits: [[{ start: 0, end: 1, insert: 'ق' }]],
        segments: [],
        warnings: [],
        applied: { proofread: 0, punctuation: 0 },
        tashkeelRan: true
      })
    }
    const fake = createFakeWord({
      paragraphs: [{ runs: [{ t: 'كتاب' }] }],
      selection: { from: { p: 0, c: 0 }, to: { p: 0, c: 4 } }
    })
    const runner = new Runner({ host: fake.Word, api: evil, supported: () => true })
    await expect(runner.preview('tashkeel')).rejects.toMatchObject({ code: 'base_changed' })
  })
  it('a paragraph whose characters do not match what Word returns is left untouched', async () => {
    const written: string[] = []
    const range = {
      text: 'كتاب',
      load() {
        return this
      },
      search: () => ({
        items: [{ text: 'ك' }, { text: 'ت' }, { text: 'ب' }].map((t) => ({
          ...t,
          insertText: () => written.push('w'),
          delete: () => written.push('d')
        })),
        load() {
          return this
        }
      })
    }
    const ctx = { sync: async () => undefined } as unknown as WContext
    const rep = await applyParagraphEdits(
      ctx,
      [
        {
          text: 'كتاب',
          fullText: 'كتاب',
          skip: null,
          inTable: false,
          range: range as never,
          paragraph: range as never
        }
      ],
      new Map([[0, [{ start: 1, end: 1, insert: 'َ' }]]])
    )
    expect(rep).toMatchObject({ edited: 0, unmapped: 1 })
    expect(written).toEqual([])
  })
  it('readSelection reports fields / controls per paragraph', async () => {
    const { fake } = setup([{ runs: [{ t: 'كتاب' }], fields: 2 }])
    const r = await fake.Word.run((ctx) => readSelection(ctx))
    expect(r.paras[0].skip).toBe('field')
  })
})
