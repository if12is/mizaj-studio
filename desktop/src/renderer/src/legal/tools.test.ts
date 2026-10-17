import { describe, expect, it } from 'vitest'
import {
  applyTextEdits,
  buildCitationEdits,
  buildLintIssues,
  buildMapping,
  buildRedactionEdits,
  combineEdits,
  defaultSelection,
  groupByRule,
  mappingToCsv,
  modalityCounts,
  sideSegments,
  validEdits,
  visibleRows,
  type CmpHunk,
  type CmpRow,
  type RawLintIssue,
  type RawRedaction
} from './tools'

const e = (from: number, to: number, expected: string, insert: string) => ({
  from,
  to,
  expected,
  insert
})

describe('text edits', () => {
  it('applies non-overlapping edits and skips stale or overlapping ones', () => {
    const t = 'abc def ghi'
    const r = applyTextEdits(t, [
      e(0, 3, 'abc', 'X'),
      e(4, 7, 'WRONG', 'Y'),
      e(8, 11, 'ghi', 'Z'),
      e(2, 5, 'c d', 'Q')
    ])
    expect(r.text).toBe('X def Z')
    expect(r.applied).toBe(2)
    expect(r.skipped).toBe(2)
  })
  it('validEdits drops out-of-range edits', () => {
    expect(validEdits('ab', [e(1, 9, 'b', 'x')]).ok).toEqual([])
  })
  it('combines edits into a single replacement that equals applying them all', () => {
    const t = '0123 abc 4567 def 89'
    const edits = [e(5, 8, 'abc', 'A'), e(14, 17, 'def', 'DD')]
    const c = combineEdits(t, edits)!
    expect(c.edit.from).toBe(5)
    expect(c.edit.to).toBe(17)
    expect(t.slice(0, c.edit.from) + c.edit.insert + t.slice(c.edit.to)).toBe(
      applyTextEdits(t, edits).text
    )
    expect(combineEdits(t, [e(0, 1, 'zz', 'q')])).toBeNull()
  })
})

describe('lint helpers', () => {
  it('converts code points to UTF-16 after astral characters', () => {
    const text = '😀 و/أو ب'
    const raw: RawLintIssue[] = [
      { rule: 'and_or', severity: 'warning', start: 2, end: 6, text: 'و/أو', message_ar: 'm' }
    ]
    const [i] = buildLintIssues(text, raw)
    expect(i.from).toBe(3)
    expect(i.text).toBe('و/أو')
  })
  it('groups by rule and counts modalities', () => {
    const issues = buildLintIssues('aaaa', [
      { rule: 'r1', severity: 'info', start: 0, end: 1, text: 'a', message_ar: '' },
      { rule: 'r2', severity: 'info', start: 1, end: 2, text: 'a', message_ar: '' },
      { rule: 'r1', severity: 'info', start: 2, end: 3, text: 'a', message_ar: '' }
    ])
    expect(groupByRule(issues).map((g) => [g.rule, g.items.length])).toEqual([
      ['r1', 2],
      ['r2', 1]
    ])
    const c = modalityCounts([{ kinds: ['obligation'] }, { kinds: ['obligation', 'permission'] }])
    expect(c.find((x) => x.kind === 'obligation')!.count).toBe(2)
    expect(c.find((x) => x.kind === 'prohibition')!.count).toBe(0)
  })
})

describe('redaction helpers', () => {
  const text = 'هاتف 0501234567 وبريد a@b.com'
  const raw: RawRedaction[] = [
    {
      id: 1,
      category: 'phone',
      kind: 'p',
      start: 5,
      end: 15,
      original: '0501234567',
      replacement: '[هاتف 1]',
      confidence: 'high',
      note: ''
    },
    {
      id: 2,
      category: 'email',
      kind: 'e',
      start: 22,
      end: 29,
      original: 'a@b.com',
      replacement: '[بريد 1]',
      confidence: 'low',
      note: ''
    }
  ]
  it('builds edits, defaults low confidence to unchecked, and applies', () => {
    const edits = buildRedactionEdits(text, raw)
    expect(edits[0].expected).toBe('0501234567')
    expect(defaultSelection(edits)).toEqual([1])
    expect(
      applyTextEdits(
        text,
        edits.filter((x) => x.id === 1)
      ).text
    ).toBe('هاتف [هاتف 1] وبريد a@b.com')
  })
  it('builds a mapping that counts repeats and exports CSV', () => {
    const edits = buildRedactionEdits(text, raw)
    const m = buildMapping([...edits, edits[0]])
    expect(m.find((r) => r.replacement === '[هاتف 1]')!.count).toBe(2)
    const csv = mappingToCsv(m)
    expect(csv.split('\r\n')[0]).toBe('"replacement","category","original","count"')
    expect(csv).toContain('"0501234567"')
  })
})

describe('citations', () => {
  it('turns suggestions into verified edits', () => {
    const t = 'وفق المادة 5 من النظام'
    const [x] = buildCitationEdits(t, [
      { kind: 'format_article', start: 4, end: 12, original: 'المادة 5', suggested: 'المادة (5)' }
    ])
    expect(x.expected).toBe('المادة 5')
    expect(applyTextEdits(t, [x]).text).toBe('وفق المادة (5) من النظام')
  })
})

describe('compare view', () => {
  const hunks: CmpHunk[] = [
    {
      index: 0,
      type: 'replace',
      a: { start: 28, end: 31, text: 'ألف' },
      b: { start: 28, end: 32, text: 'ألفي' },
      categories: ['amounts']
    },
    {
      index: 1,
      type: 'format_only',
      a: { start: 0, end: 4, text: 'يلتز' },
      b: { start: 0, end: 4, text: 'يَلتز' },
      categories: []
    }
  ]
  const a = 'يلتزم الطرف الأول بدفع مبلغ ألف ريال'
  it('highlights changed words and hides format-only by default', () => {
    const segs = sideSegments({ start: 0, end: a.length, text: a }, 'a', hunks, [0, 1], false)
    expect(segs.filter((s) => s.kind === 'change').map((s) => s.text)).toEqual(['ألف'])
    expect(segs.some((s) => s.kind === 'format')).toBe(false)
    expect(segs.map((s) => s.text).join('')).toBe(a)
    const withFormat = sideSegments({ start: 0, end: a.length, text: a }, 'a', hunks, [0, 1], true)
    expect(withFormat.some((s) => s.kind === 'format')).toBe(true)
    expect(withFormat.map((s) => s.text).join('')).toBe(a)
  })
  it('filters rows', () => {
    const rows: CmpRow[] = [
      { status: 'equal', a: null, b: null, hunks: [] },
      { status: 'format_only', a: null, b: null, hunks: [] },
      { status: 'changed', a: null, b: null, hunks: [] }
    ]
    expect(visibleRows(rows, { showFormat: false, showEqual: false })).toHaveLength(1)
    expect(visibleRows(rows, { showFormat: true, showEqual: true })).toHaveLength(3)
  })
})
