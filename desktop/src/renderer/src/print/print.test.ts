import { describe, expect, it } from 'vitest'
import { pageLabel, toArabicIndic } from '@renderer/lib/arabicDigits'
import { paginate, type Block } from './layout'
import { caseLine } from './sheets'

describe('Arabic-Indic page numbers', () => {
  it('converts digits', () => {
    expect(toArabicIndic(2026)).toBe('٢٠٢٦')
    expect(pageLabel(1, 5)).toBe('صفحة ١ من ٥')
    expect(pageLabel(12, 30)).toBe('صفحة ١٢ من ٣٠')
  })
})

const para = (top: number, lines: number, lh = 20, gap = 10): Block => ({
  top,
  bottom: top + lines * lh + gap,
  lineHeight: lh
})

describe('paginate', () => {
  it('always yields one page, even for an empty document', () => {
    expect(paginate([], 500)).toHaveLength(1)
    expect(paginate([para(0, 2)], 500)).toEqual([{ start: 0, end: 50 }])
  })
  it('moves a block that does not fit to the next page', () => {
    const b = [para(0, 10), { top: 210, bottom: 330, lineHeight: null }]
    const p = paginate(b, 300)
    expect(p).toHaveLength(2)
    expect(p[0].end).toBe(210)
    expect(p[1]).toEqual({ start: 210, end: 330 })
  })
  it('splits a long paragraph on a line boundary', () => {
    const p = paginate([para(0, 40)], 300) // 800px of 20px lines
    expect(p.length).toBe(3)
    for (const w of p.slice(0, -1)) expect((w.end - 0) % 20).toBe(0)
    // pages are contiguous and cover the whole flow
    p.slice(1).forEach((w, i) => expect(w.start).toBe(p[i].end))
    expect(p[p.length - 1].end).toBe(810)
  })
  it('cuts a block taller than a page at the page edge instead of looping', () => {
    const p = paginate([{ top: 0, bottom: 1000, lineHeight: null }], 300)
    expect(p.map((w) => w.end)).toEqual([300, 600, 900, 1000])
  })
  it('page count grows with the amount of text', () => {
    const blocks = Array.from({ length: 100 }, (_, i) => para(i * 70, 3))
    expect(paginate(blocks, 700).length).toBeGreaterThan(8)
  })
})

describe('caseLine', () => {
  it('lists only the filled fields', () => {
    expect(caseLine(null)).toBe('')
    expect(caseLine({ number: ' 123/2026 ', court: '', parties: 'أحمد ضد خالد' })).toBe(
      'رقم القضية: 123/2026 · الأطراف: أحمد ضد خالد'
    )
  })
})
