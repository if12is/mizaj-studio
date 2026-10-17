import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { history, undo, undoDepth } from '@codemirror/commands'
import { findAll, nextMatch, normalize, replacementText, type FindOptions } from './findModel'
import { findField, setFind } from './find'
import { LONG_LINE_THRESHOLD, longestLine, splitLongLineEdits } from './longLines'

const base: FindOptions = { ignoreMarks: true, foldLetters: false, wholeWord: false }

describe('diacritics-aware find model', () => {
  const src = 'كِتَابٌ جَمِيلٌ وكتاب آخر'
  it('ignoring marks finds both marked and unmarked forms, covering trailing marks', () => {
    const m = findAll(src, 'كتاب', base)
    expect(m.map((x) => src.slice(x.from, x.to))).toEqual(['كِتَابٌ', 'كتاب'])
  })
  it('a marked query matches only identical marks when marks are exact', () => {
    const o = { ...base, ignoreMarks: false }
    expect(findAll(src, 'كتاب', o).map((x) => src.slice(x.from, x.to))).toEqual(['كتاب'])
    expect(findAll(src, 'كِتَابٌ', o)).toHaveLength(1)
  })
  it('ignoring marks also ignores marks typed in the query', () => {
    expect(findAll(src, 'كِتاب', base)).toHaveLength(2)
  })
  it('hamza/alef/taa-marbuta folding is optional', () => {
    const t = 'أحمد وإحسان ومدرسة'
    expect(findAll(t, 'احمد', base)).toHaveLength(0)
    const f = { ...base, foldLetters: true }
    expect(findAll(t, 'احمد', f)).toHaveLength(1)
    expect(findAll(t, 'احسان', f)).toHaveLength(1)
    expect(findAll(t, 'مدرسه', f)).toHaveLength(1)
  })
  it('whole-word mode rejects partial-word hits (marks count as word chars)', () => {
    const t = 'علم والعلم وعِلْمٌ علم عِلْمٌ'
    const w = { ...base, wholeWord: true }
    expect(findAll(t, 'علم', w).map((m) => t.slice(m.from, m.to))).toEqual(['علم', 'علم', 'عِلْمٌ'])
    expect(findAll(t, 'علم', base)).toHaveLength(5)
  })
  it('maps normalized positions back to the original with marks stripped', () => {
    const n = normalize('بَاب', base)
    expect(n.text).toBe('باب')
    expect(n.map).toEqual([0, 2, 3])
  })
  it('replacement keeps or strips its own marks', () => {
    expect(replacementText('كِتَابٌ', false)).toBe('كِتَابٌ')
    expect(replacementText('كِتَابٌ', true)).toBe('كتاب')
  })
  it('next/prev wrap', () => {
    const m = [
      { from: 2, to: 4 },
      { from: 10, to: 12 }
    ]
    expect(nextMatch(m, 3, 1)).toBe(1)
    expect(nextMatch(m, 11, 1)).toBe(0)
    expect(nextMatch(m, 2, -1)).toBe(1)
    expect(nextMatch([], 0, 1)).toBe(-1)
  })
})

describe('find state and replace-all transaction', () => {
  const mk = (doc: string) => EditorState.create({ doc, extensions: [findField, history()] })
  it('replace-all is one undo step and positions stay correct after marks', () => {
    let s = mk('كِتَابٌ و كتاب و الكتاب')
    s = s.update({ effects: setFind.of({ query: 'كتاب', replacement: 'مقال' }) }).state
    expect(s.field(findField).matches).toHaveLength(3)
    const f = s.field(findField)
    s = s.update({
      changes: f.matches.map((m) => ({ from: m.from, to: m.to, insert: f.replacement })),
      userEvent: 'find.replaceAll'
    }).state
    expect(s.doc.toString()).toBe('مقال و مقال و المقال')
    expect(s.field(findField).matches).toHaveLength(0)
    expect(undoDepth(s)).toBe(1)
    let st = s
    undo({ state: st, dispatch: (tr) => (st = st.update(tr).state) })
    expect(st.doc.toString()).toBe('كِتَابٌ و كتاب و الكتاب')
  })
  it('matches are recomputed when the document changes', () => {
    let s = mk('علم')
    s = s.update({ effects: setFind.of({ query: 'علم' }) }).state
    expect(s.field(findField).matches).toHaveLength(1)
    s = s.update({ changes: { from: 3, insert: ' علم' } }).state
    expect(s.field(findField).matches).toHaveLength(2)
  })
})

describe('long line splitting (7.2.4)', () => {
  const sentence = 'هذه جملة طويلة نسبيا للاختبار. '
  const long = sentence.repeat(Math.ceil(LONG_LINE_THRESHOLD / sentence.length) + 20)
  it('splits only long lines, after sentence punctuation, preserving all other characters', () => {
    const doc = `قصير\n${long}\nأخير`
    const lines: { from: number; text: string }[] = []
    let pos = 0
    for (const t of doc.split('\n')) {
      lines.push({ from: pos, text: t })
      pos += t.length + 1
    }
    expect(longestLine(lines.map((l) => l.text))).toBe(long.length)
    const { edits, lines: n } = splitLongLineEdits(lines)
    expect(n).toBe(1)
    expect(edits.length).toBeGreaterThan(10)
    const s = EditorState.create({ doc, extensions: [history()] })
    const out = s.update({ changes: edits, userEvent: 'x' }).state
    expect(out.doc.toString().replace(/\n/g, ' ')).toBe(doc.replace(/\n/g, ' '))
    expect(longestLine(out.doc.toString().split('\n'))).toBeLessThan(200)
  })
  it('falls back to spaces when there is no punctuation', () => {
    const t = 'كلمة '.repeat(3000)
    const { edits } = splitLongLineEdits([{ from: 0, text: t }])
    expect(edits.length).toBeGreaterThan(5)
    expect(edits.every((e) => t[e.from] === ' ')).toBe(true)
  })
})
