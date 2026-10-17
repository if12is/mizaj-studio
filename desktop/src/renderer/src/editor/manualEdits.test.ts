import { describe, expect, it } from 'vitest'
import {
  addManualEdit,
  emptyManualEdits,
  manualEditsKey,
  MAX_TRACKED_WORDS,
  parseManualEdits,
  serializeManualEdits
} from './manualEdits'

describe('manual edits persistence model', () => {
  it('uses the per-document settings key', () => {
    expect(manualEditsKey(42)).toBe('manual_edits:42')
  })
  it('counts occurrences and keeps unique words', () => {
    let m = emptyManualEdits()
    m = addManualEdit(m, 1, 'كتاب')
    m = addManualEdit(m, 3, 'كتاب')
    m = addManualEdit(m, 1, 'علم')
    expect(m).toEqual({ count: 5, words: ['كتاب', 'علم'] })
    expect(addManualEdit(m, 0, 'x')).toBe(m)
  })
  it('round-trips through JSON', () => {
    const m = addManualEdit(emptyManualEdits(), 2, 'كتاب')
    expect(parseManualEdits(serializeManualEdits(m))).toEqual(m)
  })
  it('parse is tolerant of missing/garbage values', () => {
    expect(parseManualEdits(undefined)).toEqual(emptyManualEdits())
    expect(parseManualEdits('not json')).toEqual(emptyManualEdits())
    expect(parseManualEdits('{"count":-4,"words":[1,"a"]}')).toEqual({ count: 0, words: ['a'] })
  })
  it('caps the tracked word list', () => {
    let m = emptyManualEdits()
    for (let i = 0; i < MAX_TRACKED_WORDS + 50; i++) m = addManualEdit(m, 1, 'w' + i)
    expect(m.words.length).toBe(MAX_TRACKED_WORDS)
    expect(m.count).toBe(MAX_TRACKED_WORDS + 50)
  })
})
