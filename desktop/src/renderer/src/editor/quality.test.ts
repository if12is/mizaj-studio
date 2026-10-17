import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { history, undo, undoDepth } from '@codemirror/commands'
import {
  addConfidence,
  buildConfMarks,
  confField,
  heat,
  markReviewed,
  nextCandidate,
  reviewCandidates,
  reviewStats,
  type ConfMark
} from './confidence'
import {
  allowQuranChange,
  dropProtected,
  quranExtension,
  quranField,
  setQuranSpans,
  toSpans,
  touchesProtected,
  type QuranSpanRaw
} from './quran'
import { normalizeSpec, type NormEdit } from './normalizeEdits'
import { sentenceBounds } from './arabic'
import { RunSession, type StreamChunk } from './runSession'
import { describeHemistich, METER_FEET } from './meters'
import { osmanBand } from '../stores/quality'

describe('confidence marks', () => {
  const doc = 'كَتَبَ الوَلَدُ الدَّرسَ'
  const mk = () => EditorState.create({ doc, extensions: [confField, history()] })
  it('builds marks from server offsets and follows edits; editing the word resolves it', () => {
    const s0 = mk()
    const marks = buildConfMarks(
      s0,
      [{ u16_start: 7, u16_end: 15, confidence: 0.4, irab_confidence: 0.3 }],
      0
    )
    expect(marks[0].word).toBe('الوَلَدُ')
    let s = s0.update({ effects: addConfidence.of(marks) }).state
    s = s.update({ changes: { from: 0, insert: 'ثم ' } }).state
    expect(s.field(confField)[0].from).toBe(10)
    s = s.update({ changes: { from: 11, to: 12, insert: 'ك' } }).state
    expect(s.field(confField)).toHaveLength(0)
  })
  it('ignores empty / out of range words and heat is clamped', () => {
    expect(
      buildConfMarks(
        mk(),
        [{ u16_start: 3, u16_end: 3, confidence: 0.1, irab_confidence: null }],
        0
      )
    ).toEqual([])
    expect(
      buildConfMarks(
        mk(),
        [{ u16_start: 3, u16_end: 999, confidence: 0.1, irab_confidence: null }],
        0
      )
    ).toEqual([])
    expect(heat(0.99)).toBe(0.15)
    expect(heat(0)).toBe(1)
  })
})

describe('review mode model', () => {
  const m = (from: number, c: number, irab: number | null = null, reviewed = false): ConfMark => ({
    from,
    to: from + 3,
    word: 'xxx',
    confidence: c,
    irab,
    reviewed
  })
  const marks = [
    m(0, 0.4),
    m(10, 0.9),
    m(20, 0.95, 0.3),
    m(30, 0.2, null, true),
    m(40, 0.5),
    m(50, 0.5)
  ]
  it("candidates: low word or i'rab certainty, not reviewed, never inside Quran spans", () => {
    const c = reviewCandidates(marks, 0.7, [{ from: 49, to: 60 }])
    expect(c.map((x) => x.from)).toEqual([0, 20, 40])
  })
  it('next/prev wrap and stats count progress', () => {
    const c = reviewCandidates(marks, 0.7)
    expect(nextCandidate(c, 0, 1)?.from).toBe(20)
    expect(nextCandidate(c, 50, 1)?.from).toBe(0)
    expect(nextCandidate(c, 0, -1)?.from).toBe(50)
    expect(nextCandidate([], 0, 1)).toBeNull()
    expect(reviewStats(marks, 0.7)).toEqual({ total: 5, reviewed: 1, remaining: 4 })
  })
  it('markReviewed effect flags just that mark', () => {
    let s = EditorState.create({ doc: 'a'.repeat(60), extensions: [confField] })
    s = s.update({ effects: addConfidence.of(marks.slice(0, 2)) }).state
    s = s.update({ effects: markReviewed.of(0) }).state
    expect(s.field(confField).map((x) => x.reviewed)).toEqual([true, false])
  })
})

describe('Quran protection transaction filter', () => {
  const doc = 'قال الله: بسم الله الرحمن الرحيم صدق'
  const raw: QuranSpanRaw[] = [
    {
      start16: 10,
      end16: 32,
      sura: 1,
      aya: 1,
      ref: '1:1',
      kind: 'verse',
      bracketed: false,
      needs_confirmation: false
    }
  ]
  const make = (protect = true) => {
    const blocked = vi.fn()
    const base = EditorState.create({
      doc,
      extensions: [history(), quranExtension({ isProtected: () => protect, onBlocked: blocked })]
    })
    const spans = toSpans(raw, 0, base.doc)
    const s = base.update({
      effects: setQuranSpans.of({ ranges: [{ from: 0, to: doc.length }], spans })
    }).state
    return { s, blocked }
  }
  it('rejects edits inside a protected span and reports the reference', () => {
    const { s, blocked } = make()
    expect(s.field(quranField)).toHaveLength(1)
    const bad = s.update({ changes: { from: 12, to: 13, insert: 'x' } }).state
    expect(bad.doc.toString()).toBe(doc)
    expect(blocked).toHaveBeenCalledWith('1:1')
    const bad2 = s.update({ changes: { from: 20, insert: 'ً' } }).state // insertion inside the span
    expect(bad2.doc.toString()).toBe(doc)
    const bad3 = s.update({ changes: { from: 5, to: 15, insert: '' } }).state // deletion overlapping the span
    expect(bad3.doc.toString()).toBe(doc)
  })
  it('allows edits outside and at the edges, and when protection is off or annotated', () => {
    const { s } = make()
    expect(
      s
        .update({ changes: { from: 0, to: 3, insert: 'قول' } })
        .state.doc.toString()
        .startsWith('قول')
    ).toBe(true)
    expect(s.update({ changes: { from: 10, insert: 'ـ' } }).state.doc.length).toBe(doc.length + 1) // before span
    expect(s.update({ changes: { from: 32, insert: '!' } }).state.doc.length).toBe(doc.length + 1) // right after
    expect(
      make(false)
        .s.update({ changes: { from: 12, to: 13, insert: 'x' } })
        .state.doc.toString()
    ).not.toBe(doc)
    const ok = s.update({
      changes: { from: 12, to: 13, insert: 'x' },
      annotations: allowQuranChange.of(true)
    }).state
    expect(ok.doc.toString()).not.toBe(doc)
  })
  it('spans follow edits and vanish when the verse text itself changes (protection off)', () => {
    let { s } = make()
    s = s.update({ changes: { from: 0, insert: 'ثم ' } }).state
    expect(s.field(quranField)[0].from).toBe(13)
  })
  it('touchesProtected / dropProtected helpers', () => {
    const { s } = make()
    const tr = s.update({ changes: { from: 12, to: 13, insert: 'x' }, filter: false })
    expect(touchesProtected(tr, s.field(quranField))).toBe(true)
    const edits = [
      { from: 0, to: 2 },
      { from: 12, to: 14 },
      { from: 20, to: 20 }
    ]
    expect(dropProtected(edits, s.field(quranField))).toEqual([{ from: 0, to: 2 }])
  })
  it('undo of an allowed outside edit still works', () => {
    let { s } = make()
    s = s.update({ changes: { from: 0, insert: 'ثم ' }, userEvent: 'input' }).state
    expect(undoDepth(s)).toBe(1)
    undo({ state: s, dispatch: (t) => (s = s.update(t).state) })
    expect(s.doc.toString()).toBe(doc)
  })
})

describe('typography normalize apply', () => {
  const edit = (start16: number, end16: number, old: string, nw: string): NormEdit => ({
    start16,
    end16,
    old,
    new: nw,
    code: 'TYPO',
    message_ar: '',
    severity: 'info'
  })
  const doc = 'كــــتاب ﻟﻠﻮﻟﺪ ١٢٣'
  const edits = [edit(1, 5, 'ــــ', ''), edit(9, 14, 'ﻟﻠﻮﻟﺪ', 'للولد'), edit(15, 18, '١٢٣', '123')]
  it('applies only the selected edits as ONE undoable transaction', () => {
    const s = EditorState.create({ doc, extensions: [history()] })
    const r = normalizeSpec(s, 0, edits, new Set([0, 1]))
    expect(r.applied).toBe(2)
    const n = s.update(r.spec!).state
    expect(n.doc.toString()).toBe('كتاب للولد ١٢٣')
    expect(undoDepth(n)).toBe(1)
    let st = n
    undo({ state: st, dispatch: (t) => (st = st.update(t).state) })
    expect(st.doc.toString()).toBe(doc)
  })
  it('honours the base offset (selection) and skips stale edits', () => {
    const s = EditorState.create({ doc: 'xx ' + doc })
    const r = normalizeSpec(s, 3, edits, new Set([0, 1, 2]))
    expect(s.update(r.spec!).state.doc.toString()).toBe('xx كتاب للولد 123')
    const stale = normalizeSpec(
      EditorState.create({ doc: 'تغير النص تماما هنا وهناك' }),
      0,
      edits,
      new Set([0, 1, 2])
    )
    expect(stale.spec).toBeNull()
    expect(stale.skipped).toBe(3)
  })
})

describe('sentence bounds', () => {
  const doc = EditorState.create({ doc: 'الجملة الأولى. وجملة ثانية؟ وثالثة' }).doc
  it('finds the sentence around a position', () => {
    expect(doc.sliceString(sentenceBounds(doc, 3).from, sentenceBounds(doc, 3).to)).toBe(
      'الجملة الأولى.'
    )
    const b = sentenceBounds(doc, 20)
    expect(doc.sliceString(b.from, b.to)).toBe('وجملة ثانية؟')
    const c = sentenceBounds(doc, doc.length)
    expect(doc.sliceString(c.from, c.to)).toBe('وثالثة')
  })
})

describe('RunSession with confidence + Quran protection', () => {
  const chunk = (
    text: string,
    words: StreamChunk['words'],
    start = 0,
    end = text.length
  ): StreamChunk => ({
    chunk_id: 1,
    start,
    end,
    text,
    progress: 100,
    wps: 1,
    cached: 0,
    words
  })
  it('collects low-confidence marks at their final document positions', () => {
    const src = 'كتب الولد. ذهب الرجل'
    const s = EditorState.create({ doc: src })
    const sess = new RunSession(s, 0, src)
    let st = s
    const c1 = chunk(
      'كَتَبَ الوَلَدُ.',
      [{ u16_start: 7, u16_end: 15, confidence: 0.4, irab_confidence: null }],
      0,
      10
    )
    const c2 = chunk(
      ' ذَهَبَ الرَّجُلُ',
      [{ u16_start: 8, u16_end: 17, confidence: 0.3, irab_confidence: 0.2 }],
      10,
      20
    )
    st = st.update(sess.applyChunk(st, c1)!).state
    st = st.update(sess.applyChunk(st, c2)!).state
    for (const f of sess.finish(st)) st = st.update(f).state
    const marks = buildConfMarks(st, sess.takeConfidence(), 0)
    expect(marks.map((m) => m.word)).toEqual(['الوَلَدُ', 'الرَّجُلُ'])
    expect(marks[0].confidence).toBe(0.4)
  })
  it('skips a chunk whose edits would touch protected text', () => {
    const src = 'كتب الولد'
    const s = EditorState.create({ doc: src })
    const sess = new RunSession(s, 0, src, { isProtected: (a, b) => a < 9 && b > 4 })
    expect(sess.applyChunk(s, chunk('كَتَبَ الوَلَدُ', undefined, 0, 9))).toBeNull()
    expect(sess.skipped).toBe(1)
  })
})

describe('poetry helpers', () => {
  it('describeHemistich is honest about failures', () => {
    expect(describeHemistich({ text: 'x', meters: ['الطويل'], missing_marks: [] })).toBe(
      'البحر: الطويل'
    )
    expect(describeHemistich({ text: 'x', meters: [], missing_marks: [1, 2] })).toContain(
      '2 حرف بلا تشكيل'
    )
    expect(
      describeHemistich({
        text: 'x',
        meters: [],
        missing_marks: [],
        closest: { meter: 'الكامل', matched_letters: 16 }
      })
    ).toContain('الأقرب الكامل حتى الحرف 16')
    expect(describeHemistich({ text: 'x', meters: [], missing_marks: [] })).toBe('لا بحر مطابق')
  })
  it('meter feet table covers the 16 classical meters', () => {
    expect(Object.keys(METER_FEET)).toHaveLength(16)
    expect(METER_FEET['الطويل']).toEqual(['فعولن', 'مفاعيلن', 'فعولن', 'مفاعيلن'])
  })
  it('osmanBand maps scores to plain-language bands', () => {
    expect(osmanBand(85)).toBe('سهل')
    expect(osmanBand(65)).toBe('متوسط')
    expect(osmanBand(45)).toBe('صعب نسبياً')
    expect(osmanBand(10)).toBe('صعب')
    expect(osmanBand(null)).toBe('غير متاح')
  })
})
