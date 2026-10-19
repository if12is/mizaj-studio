import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markOnlyCorrection, repeatEdits } from './learning'
import { doubtView, toArabicDigits } from './doubtChip'
import { reviewPosition, type ConfMark } from './confidence'

function change(doc: string, from: number, to: number, insert: string) {
  const s = EditorState.create({ doc })
  const tr = s.update({ changes: { from, to, insert } })
  return { old: s.doc, next: tr.newDoc, changes: tr.changes }
}

describe('markOnlyCorrection', () => {
  it('reports a typed mark on one word', () => {
    // "كتاب" + fatha after the kaf
    const c = change('قرأ كتاب جديد', 5, 5, 'َ')
    const r = markOnlyCorrection(c.old, c.next, c.changes)
    expect(r?.bare).toBe('كتاب')
    expect(r?.form).toBe('كَتاب')
  })
  it('ignores edits that touch base letters', () => {
    const c = change('قرأ كتاب', 4, 4, 'ا')
    expect(markOnlyCorrection(c.old, c.next, c.changes)).toBeNull()
  })
  it('ignores a word that ends up without any mark', () => {
    const c = change('كَتاب', 1, 2, '')
    expect(markOnlyCorrection(c.old, c.next, c.changes)).toBeNull()
  })
})

describe('repeatEdits', () => {
  it('counts the other occurrences with the same base letters', () => {
    const text = 'كتاب جديد\nالكتاب كتاب كَتَابٌ'
    const r = repeatEdits(text, 'كتاب', 'كِتَابٌ')
    expect(r.words).toBe(3)
    // the form itself is not counted
    expect(repeatEdits('كِتَابٌ كتاب', 'كتاب', 'كِتَابٌ').words).toBe(1)
  })
})

describe('doubt chip model', () => {
  it('shows N, the position and the done state', () => {
    expect(doubtView({ active: false, total: 0, remaining: 0 }).kind).toBe('hidden')
    expect(doubtView({ active: false, total: 43, remaining: 43 })).toEqual({
      kind: 'doubt',
      text: 'الكلمات المشكوك فيها: 43',
      position: null
    })
    expect(doubtView({ active: true, total: 43, remaining: 40, position: 3 })).toMatchObject({
      position: '٣ / ٤٣'
    })
    expect(doubtView({ active: true, total: 43, remaining: 0 })).toEqual({
      kind: 'done',
      text: 'تمت المراجعة ✓'
    })
    expect(toArabicDigits(1205)).toBe('١٢٠٥')
  })
  it('position is the index among all flagged words', () => {
    const m = (from: number, confidence: number, reviewed = false): ConfMark => ({
      from,
      to: from + 4,
      word: 'xxxx',
      confidence,
      irab: null,
      reviewed
    })
    const marks = [m(0, 0.2), m(10, 0.9), m(20, 0.3, true), m(30, 0.1)]
    expect(reviewPosition(marks, 0.7, 22)).toBe(2)
    expect(reviewPosition(marks, 0.7, 31)).toBe(3)
    expect(reviewPosition(marks, 0.7, 12)).toBe(0)
  })
})
