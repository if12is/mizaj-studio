import { describe, expect, it } from 'vitest'
import {
  allCopyText,
  confidenceLevel,
  fieldCopyText,
  isHidden,
  jumpTargets,
  setHidden,
  toEditorOffsets,
  type CardField
} from './caseCard'
import { buildLegalIssues, groupIssues } from './issues'

const field = (over: Partial<CardField> = {}): CardField => ({
  key: 'case_number',
  label_ar: 'رقم الدعوى',
  value: '624 لسنة 2026',
  confidence: 0.95,
  start: 3,
  end: 10,
  ...over
})

describe('case card helpers', () => {
  it('converts code-point offsets to UTF-16 after astral characters', () => {
    const text = '😀 الدعوى رقم 1'
    const cp = [...text].indexOf('ا')
    const [f] = toEditorOffsets(text, [
      field({ start: cp, end: cp + 6, occurrences: [{ start: cp, end: cp + 6 }] })
    ])
    expect(f.start).toBe(text.indexOf('ا'))
    expect(f.occurrences?.[0].start).toBe(text.indexOf('ا'))
  })

  it('classifies confidence', () => {
    expect(confidenceLevel(0.95)).toBe('high')
    expect(confidenceLevel(0.7)).toBe('mid')
    expect(confidenceLevel(0.4)).toBe('low')
  })

  it('jump targets prefer items, then occurrences, then the field itself', () => {
    const items = [{ start: 1, end: 2, text: 'x', confidence: 1 }]
    expect(jumpTargets(field({ items }))).toEqual(items)
    const occurrences = [
      { start: 1, end: 2 },
      { start: 5, end: 6 }
    ]
    expect(jumpTargets(field({ occurrences }))).toEqual(occurrences)
    expect(jumpTargets(field())).toHaveLength(1)
  })

  it('copies one field or all of them', () => {
    expect(fieldCopyText(field())).toBe('624 لسنة 2026')
    const all = allCopyText([field(), field({ key: 'relief', label_ar: 'الطلبات', value: 'أ\nب' })])
    expect(all).toBe('رقم الدعوى: 624 لسنة 2026\nالطلبات:\nأ\nب')
  })

  it('remembers the hidden flag per document and survives broken storage', () => {
    const mem = new Map<string, string>()
    const s = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k)
    }
    expect(isHidden(1, s)).toBe(false)
    setHidden(1, true, s)
    expect(isHidden(1, s)).toBe(true)
    expect(isHidden(2, s)).toBe(false)
    setHidden(1, false, s)
    expect(isHidden(1, s)).toBe(false)
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      }
    }
    expect(isHidden(1, broken)).toBe(false)
    expect(() => setHidden(1, true, broken)).not.toThrow()
    expect(isHidden(null, s)).toBe(false)
  })
})

describe('refs warnings in the legal checks list', () => {
  it('become a jumpable "refs" group without any fix', () => {
    const text = 'حرر بتاريخ 31/2/2026'
    const start = text.indexOf('31')
    const list = buildLegalIssues(text, {
      refs: {
        issues: [
          {
            start,
            end: text.length,
            type: 'date_impossible',
            message_ar: 'تاريخ غير ممكن'
          }
        ]
      }
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ group: 'refs', type: 'date_impossible', expected: '31/2/2026' })
    expect(list[0].fix).toBeUndefined()
    expect(groupIssues(list)[0].group).toBe('refs')
  })
})
