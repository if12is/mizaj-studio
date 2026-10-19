import { describe, expect, it } from 'vitest'
import type { PipelineDeps } from '../systemwide/pipeline'
import { applyEdits } from '../systemwide/textDiff'
import { PipelineError } from '../systemwide/pipeline'
import { parseProcessRequest, processParagraphs, splitEditsByParagraph } from './process'

/** The mock-mode vowelizer of AGENTS.md: fatha on the first letter, damma on the last. */
const mockTashkeel = (t: string): string =>
  t.replace(/[ء-ي]+/g, (w) => w[0] + 'َ' + w.slice(1) + (w.length > 1 ? 'ُ' : ''))

const deps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
  proofread: async () => ({ items: [] }),
  apply: async (text) => ({ text, applied: 0, skipped: 0 }),
  tashkeel: async (text) => ({ text: mockTashkeel(text) }),
  ...over
})

describe('parseProcessRequest', () => {
  it('accepts a valid request', () => {
    expect(parseProcessRequest({ op: 'tashkeel', paragraphs: ['كتاب'] })).toEqual({
      op: 'tashkeel',
      paragraphs: ['كتاب']
    })
  })
  it.each([
    null,
    'x',
    {},
    { op: 'evil', paragraphs: ['a'] },
    { op: 'all', paragraphs: [] },
    { op: 'all', paragraphs: [1] },
    { op: 'all', paragraphs: ['a\nb'] },
    { op: 'all', paragraphs: ['a\rb'] },
    { op: 'all' }
  ])('rejects %j', (b) => {
    expect(parseProcessRequest(b)).toBeNull()
  })
})

describe('splitEditsByParagraph', () => {
  const ps = ['كتاب', 'قلم']
  it('maps edits to local offsets', () => {
    const joined = ps.join('\n')
    const edits = [
      { start: 1, end: 1, insert: 'َ' },
      { start: 6, end: 6, insert: 'َ' }
    ]
    const r = splitEditsByParagraph(ps, edits)
    expect(r).toEqual([[edits[0]], [{ start: 1, end: 1, insert: 'َ' }]])
    expect(joined[5]).toBe('ق')
  })
  it('an insertion at the very end of a paragraph belongs to it', () => {
    expect(splitEditsByParagraph(ps, [{ start: 4, end: 4, insert: 'ُ' }])).toEqual([
      [{ start: 4, end: 4, insert: 'ُ' }],
      []
    ])
  })
  it('refuses an edit that touches the separator or spans paragraphs', () => {
    expect(splitEditsByParagraph(ps, [{ start: 4, end: 5, insert: '' }])).toBeNull()
    expect(splitEditsByParagraph(ps, [{ start: 3, end: 6, insert: 'x' }])).toBeNull()
    expect(splitEditsByParagraph(ps, [{ start: 1, end: 1, insert: 'a\nb' }])).toBeNull()
  })
})

describe('processParagraphs', () => {
  it('tashkeel yields mark-only per-paragraph edits that rebuild the text', async () => {
    const ps = ['كتاب جميل', 'قلم']
    const r = await processParagraphs({ op: 'tashkeel', paragraphs: ps }, deps())
    expect(r.changed).toBe(true)
    expect(r.tashkeelRan).toBe(true)
    const rebuilt = ps.map((p, i) => applyEdits(p, r.edits[i]))
    expect(rebuilt.join('\n')).toBe(mockTashkeel(ps.join('\n')))
    for (const list of r.edits) for (const e of list) expect(e.end).toBe(e.start) // pure insertions
  })
  it('unchanged text reports changed=false', async () => {
    const r = await processParagraphs(
      { op: 'tashkeel', paragraphs: ['كتاب'] },
      deps({ tashkeel: async (t) => ({ text: t }) })
    )
    expect(r.changed).toBe(false)
    expect(r.segments).toEqual([])
  })
  it('refuses a tashkeel result that changed base letters (result unchanged)', async () => {
    const r = await processParagraphs(
      { op: 'tashkeel', paragraphs: ['كتاب'] },
      deps({ tashkeel: async () => ({ text: 'قلم' }) })
    )
    expect(r.changed).toBe(false)
    expect(r.warnings.join(' ')).toContain('رفض')
  })
  it('non-Arabic input is a pipeline error with an Arabic message', async () => {
    await expect(
      processParagraphs({ op: 'all', paragraphs: ['hello'] }, deps())
    ).rejects.toBeInstanceOf(PipelineError)
  })
})
