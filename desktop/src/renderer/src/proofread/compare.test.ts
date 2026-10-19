import { describe, expect, it } from 'vitest'
import { compareLine, compareTexts, diffSeq, stripMarks } from './compare'
import {
  autoAccepted,
  countCategories,
  markedWords,
  summaryLine,
  wordsDiacritized
} from './oneStep'

const BEFORE = 'ذهب الولد الي المدرسه\nهذا كتاب جميل'
const AFTER = 'ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ\nهَذَا كِتَابٌ جَمِيلٌ'

describe('diffSeq', () => {
  it('finds equal, replace, insert and delete blocks', () => {
    expect(diffSeq(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      ['equal', 0, 1, 0, 1],
      ['replace', 1, 2, 1, 2],
      ['equal', 2, 3, 2, 3]
    ])
    expect(diffSeq(['a'], ['a', 'b'])).toEqual([
      ['equal', 0, 1, 0, 1],
      ['insert', 1, 1, 1, 2]
    ])
    expect(diffSeq(['a', 'b'], ['a'])).toEqual([
      ['equal', 0, 1, 0, 1],
      ['delete', 1, 2, 1, 1]
    ])
    expect(diffSeq([], [])).toEqual([])
  })
})

describe('compareTexts', () => {
  it('separates proofreading (letters) from diacritics-only (marks) changes', () => {
    const r = compareTexts(BEFORE, AFTER)
    expect(r.proof).toBe(2) // الي -> إلى, المدرسه -> المدرسةِ
    expect(r.diac).toBe(2 + 3) // ذهب, الولد, then هذا كتاب جميل
    const kinds = r.rows[0].segs.map((s) => s.kind)
    expect(kinds).toEqual(['diac', 'same', 'diac', 'same', 'proof', 'same', 'proof'])
  })

  it('rebuilds both texts from the segments', () => {
    const r = compareTexts(BEFORE, AFTER)
    const b = r.rows.map((row) => row.segs.map((s) => s.before).join('')).join('\n')
    const a = r.rows.map((row) => row.segs.map((s) => s.after).join('')).join('\n')
    expect(b).toBe(BEFORE)
    expect(a).toBe(AFTER)
  })

  it('knows where every changed word sits in the result (revert = one verified edit)', () => {
    const r = compareTexts(BEFORE, AFTER)
    let text = AFTER
    for (const row of r.rows)
      for (const s of row.segs) {
        if (s.kind === 'same') continue
        expect(text.slice(s.afterFrom, s.afterFrom + s.after.length)).toBe(s.after)
      }
    // revert only the second word of line 1
    const seg = r.rows[0].segs.filter((s) => s.kind !== 'same')[1]
    text = text.slice(0, seg.afterFrom) + seg.before + text.slice(seg.afterFrom + seg.after.length)
    expect(text.split('\n')[0]).toBe('ذَهَبَ الولد إِلَى المَدْرَسَةِ')
    // the other words are untouched and the rest still compares as before
    const again = compareTexts(BEFORE, text)
    expect(again.diac).toBe(r.diac - 1)
    expect(again.proof).toBe(r.proof)
  })

  it('handles insertions, deletions and a different number of paragraphs', () => {
    const r = compareTexts('أ ب', 'أ، ب')
    expect(r.proof).toBe(1)
    expect(
      r.rows[0].segs.some((s) => s.kind === 'proof' && s.before === '' && s.after === '،')
    ).toBe(true)
    const r2 = compareTexts('سطر أول\nسطر ثان\nسطر ثالث', 'سطر أول\nسطر ثالث')
    expect(
      r2.rows.some((row) => row.segs.some((s) => !s.revertable && s.before === 'سطر ثان'))
    ).toBe(true)
  })

  it('identical texts have no changes', () => {
    const r = compareTexts(AFTER, AFTER)
    expect(r.proof + r.diac).toBe(0)
    expect(r.rows.every((row) => !row.changed)).toBe(true)
  })

  it('never reports a change when only the marks are equal', () => {
    expect(compareLine('كتاب', 'كِتَابٌ', 0)[0].kind).toBe('diac')
    expect(stripMarks('كِتَابٌ')).toBe('كتاب')
  })
})

describe('one-step helpers', () => {
  const items = [
    { category: 'hamza' },
    { category: 'ya' },
    { category: 'punctuation' },
    { category: 'punctuation' }
  ] as const

  it('base-letter fixes are only auto-accepted when the setting is on', () => {
    expect(autoAccepted(items, false).map((i) => i.category)).toEqual([
      'punctuation',
      'punctuation'
    ])
    expect(autoAccepted(items, true)).toHaveLength(4)
  })

  it('counts by category and formats the single summary', () => {
    const counts = countCategories([...items])
    expect(counts).toEqual({ hamza: 1, spelling: 0, ya: 1, punctuation: 2 })
    expect(summaryLine({ fixed: counts, words: 3277, doubtful: 43 })).toBe(
      'صُحّح: ١ همزة، ١ ياء، ٢ ترقيم — شُكّلت ٣٢٧٧ كلمة — مشكوك فيها: ٤٣'
    )
    expect(
      summaryLine({
        fixed: { hamza: 45, spelling: 5, ya: 41, punctuation: 169 },
        words: 3277,
        doubtful: 43
      })
    ).toBe('صُحّح: ٤٥ همزة، ٥ إملاء، ٤١ ياء، ١٦٩ ترقيم — شُكّلت ٣٢٧٧ كلمة — مشكوك فيها: ٤٣')
    expect(
      summaryLine({
        fixed: { hamza: 0, spelling: 0, ya: 0, punctuation: 0 },
        words: 0,
        doubtful: 0
      })
    ).toBe('لا تصحيحات — شُكّلت ٠ كلمة — مشكوك فيها: ٠')
  })

  it('counts the words that received marks', () => {
    expect(markedWords('كَتَبَ الولد')).toBe(1)
    expect(wordsDiacritized('كَتَبَ الولد', 'كَتَبَ الوَلَدُ')).toBe(1)
    expect(wordsDiacritized('كَتَبَ', 'كتب')).toBe(0)
  })
})
