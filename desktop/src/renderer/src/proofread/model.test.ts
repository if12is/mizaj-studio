import { describe, expect, it } from 'vitest'
import {
  acceptedEdits,
  autoEdits,
  contextOf,
  countByDecision,
  groupItems,
  normalizeMode,
  normalizeYaStyle,
  setGroup,
  showChars,
  type Decision,
  type ProofItem
} from './model'

const mk = (
  id: string,
  category: ProofItem['category'],
  s: number,
  e: number,
  o: string,
  r: string
) =>
  ({
    id,
    start: s,
    end: e,
    start16: s,
    end16: e,
    original: o,
    replacement: r,
    category,
    code: 'X',
    reason_ar: 'سبب',
    confidence: 0.9
  }) as ProofItem

const items: ProofItem[] = [
  mk('p0', 'punctuation', 3, 4, ' ', ''),
  mk('p1', 'hamza', 0, 3, 'ابو', 'أبو'),
  mk('p2', 'ya', 10, 13, 'علي', 'على'),
  mk('p3', 'hamza', 20, 22, 'ان', 'أن')
]

describe('proofread model', () => {
  it('groups in the review order, skipping empty groups', () => {
    const g = groupItems(items)
    expect(g.map((x) => x.label)).toEqual(['همزات', 'الياء', 'ترقيم'])
    expect(g[0].items.map((i) => i.id)).toEqual(['p1', 'p3'])
    expect(groupItems([])).toEqual([])
  })

  it('accepts a whole group at once and leaves the others untouched', () => {
    let d: Record<string, Decision> = {}
    d = setGroup(d, items, 'hamza', 'accept')
    expect(d).toEqual({ p1: 'accept', p3: 'accept' })
    d = setGroup(d, items, 'punctuation', 'reject')
    expect(countByDecision(items, d, 'accept')).toBe(2)
    expect(countByDecision(items, d, 'reject')).toBe(1)
    expect(countByDecision(items, d, 'pending')).toBe(1)
  })

  it('builds edits for accepted items only, shifted by the selection offset', () => {
    const d: Record<string, Decision> = { p1: 'accept', p2: 'reject', p3: 'accept' }
    const e = acceptedEdits(items, d, 100, { p3: 'إن' })
    expect(e).toEqual([
      { from: 100, to: 103, expected: 'ابو', insert: 'أبو' },
      { from: 120, to: 122, expected: 'ان', insert: 'إن' }
    ])
    expect(acceptedEdits(items, {}, 0)).toEqual([])
  })

  it('auto mode never touches base letters', () => {
    const e = autoEdits(items, 0)
    expect(e).toEqual([{ from: 3, to: 4, expected: ' ', insert: '' }])
  })

  it('normalises the settings values', () => {
    expect(normalizeMode(undefined)).toBe('ask')
    expect(normalizeMode('auto_punct')).toBe('auto_punct')
    expect(normalizeMode('off')).toBe('off')
    expect(normalizeMode('weird')).toBe('ask')
    expect(normalizeYaStyle('egyptian')).toBe('egyptian')
    expect(normalizeYaStyle('x')).toBe('standard')
  })

  it('shows context and invisible characters', () => {
    const c = contextOf('قال ابو  حمص', { start16: 4, end16: 7 }, 4)
    expect(c).toEqual({ before: 'قال ', after: ' حم' })
    expect(showChars('')).toBe('(حذف)')
    expect(showChars(' \u00a0')).toBe('␣⍽')
  })
})
