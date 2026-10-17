import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { history, undo, redo, undoDepth, redoDepth } from '@codemirror/commands'
import { createDocumentState } from './documentState'
import {
  applyHaraka,
  computeDensity,
  letterSlots,
  setLetterMarks,
  stripMarks,
  wordBoundsAt,
  FATHA,
  SHADDA,
  DAMMA,
  KASRA
} from './arabic'
import { applyToAllEdits, diffMarkEdits, editsToSpec, stripEdits } from './markEdits'
import { applyHarakaSpec, applyToAllSpec } from './inspector'
import { RunSession, type StreamChunk } from './runSession'
import { editorPaletteClass } from './fontClass'

const mk = (doc: string, anchor = 0, head = anchor) =>
  EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [history()]
  })
const run = (s: EditorState, spec: TransactionSpec) => s.update(spec).state

describe('word bounds', () => {
  const doc = mk('مرحبا بكم، يا أهلاً').doc
  it('finds word at cursor, including marks', () => {
    expect(wordBoundsAt(doc, 2)).toEqual({ from: 0, to: 5 })
    expect(wordBoundsAt(doc, 5)).toEqual({ from: 0, to: 5 })
    const d2 = mk(`كَتَبَ x`).doc
    expect(wordBoundsAt(d2, 3)).toEqual({ from: 0, to: 6 })
  })
  it('returns null on non-words', () => {
    expect(wordBoundsAt(mk('abc 123').doc, 2)).toBeNull()
    expect(wordBoundsAt(mk('').doc, 0)).toBeNull()
  })
  it('superscript alef is part of the word', () => {
    expect(wordBoundsAt(mk('هٰذا').doc, 1)).toEqual({ from: 0, to: 4 })
  })
})

describe('mark replacement preserves the cursor', () => {
  it('anchor after a later letter shifts by inserted marks', () => {
    // كتاب, cursor after ت (pos 2), set fatha on first letter
    const s = mk('كتاب', 2)
    const spec = applyHarakaSpec(s, 0, 4, 0, 'fatha')!
    const n = run(s, spec)
    expect(n.doc.toString()).toBe('كَتاب')
    expect(n.selection.main.anchor).toBe(3) // still right after ت
    expect(n.doc.sliceString(0, n.selection.main.anchor)).toBe('كَت')
  })
  it('anchor at end of a letter block stays after the new marks', () => {
    const s = mk('كتاب', 2)
    const n = run(s, applyHarakaSpec(s, 0, 4, 1, 'damma')!)
    expect(n.doc.toString()).toBe('كتُاب')
    expect(n.selection.main.anchor).toBe(3)
  })
  it('anchor before the word and head after are both exact', () => {
    const s = mk('ab كتاب cd', 3, 8)
    const n = run(s, applyHarakaSpec(s, 3, 7, 2, 'kasra')!)
    expect(n.selection.main.anchor).toBe(3)
    expect(n.selection.main.head).toBe(9)
    expect(n.doc.sliceString(n.selection.main.head)).toBe('cd')
  })
  it('removing a mark keeps the cursor on the same letter', () => {
    const s = mk('كَتاب', 3)
    const n = run(s, applyHarakaSpec(s, 0, 5, 0, 'clear')!)
    expect(n.doc.toString()).toBe('كتاب')
    expect(n.selection.main.anchor).toBe(2)
  })
  it('a word edit is exactly one undo step', () => {
    let s = mk('كتاب', 2)
    s = run(s, applyHarakaSpec(s, 0, 4, 0, 'fatha')!)
    s = run(s, applyHarakaSpec(s, 0, 5, 1, 'damma')!)
    let st = s
    undo({ state: st, dispatch: (tr) => (st = st.update(tr).state) })
    expect(st.doc.toString()).toBe('كَتاب')
    undo({ state: st, dispatch: (tr) => (st = st.update(tr).state) })
    expect(st.doc.toString()).toBe('كتاب')
  })
  it('palette semantics', () => {
    expect(applyHaraka('', 'shadda')).toBe(SHADDA)
    expect(applyHaraka(SHADDA, 'shadda')).toBe('')
    expect(applyHaraka(SHADDA + FATHA, 'damma')).toBe(SHADDA + DAMMA)
    expect(applyHaraka(FATHA, 'kasra')).toBe(KASRA)
    expect(applyHaraka(FATHA, 'clear')).toBe('')
    expect(letterSlots('كَتَب').map((l) => l.marks)).toEqual([FATHA, FATHA, ''])
    expect(setLetterMarks('كتب', 1, FATHA)).toBe('كتَب')
  })
})

describe('apply to all / strip', () => {
  it('replaces only whole-word occurrences with the same bare form', () => {
    const s = mk('علم العلم علم، علمَ علماء')
    const r = applyToAllSpec(s, 'علم', 'عِلْمٌ')!
    const n = run(s, r.spec)
    expect(n.doc.toString()).toBe('عِلْمٌ العلم عِلْمٌ، عِلْمٌ علماء')
    expect(r.words).toBe(3)
    let st = n
    undo({ state: st, dispatch: (tr) => (st = st.update(tr).state) })
    expect(st.doc.toString()).toBe('علم العلم علم، علمَ علماء')
  })
  it('works across lines', () => {
    const { edits, words } = applyToAllEdits(
      [
        { from: 0, text: 'كتب' },
        { from: 4, text: 'كتب' }
      ],
      'كتب',
      'كَتَبَ'
    )
    expect(words).toBe(2)
    expect(edits.length).toBe(6)
  })
  it('strip is one transaction and keeps text', () => {
    const s = mk('كَتَبَ الوَلَدُ', 4, 9)
    const sel = s.selection.main
    const edits = stripEdits(s.sliceDoc(sel.from, sel.to), sel.from)
    const n = run(s, editsToSpec(s, edits, 'tashkeel.strip'))
    expect(stripMarks(n.doc.toString())).toBe('كتب الولد')
    expect(n.doc.toString().startsWith('كَتَب')).toBe(true)
    let st = n
    undo({ state: st, dispatch: (tr) => (st = st.update(tr).state) })
    expect(st.doc.toString()).toBe('كَتَبَ الوَلَدُ')
  })
  it('diffMarkEdits rejects different base text', () => {
    expect(diffMarkEdits('كتب', 'كتاب', 0)).toBeNull()
  })
})

describe('density', () => {
  it('counts letters carrying >=1 mark', () => {
    const d = computeDensity('كَتَب')
    expect(d.letters).toBe(3)
    expect(d.withMarks).toBe(2)
    expect(d.density).toBeCloseTo(66.67, 1)
    expect(computeDensity('كّـَ').withMarks).toBe(1)
    expect(computeDensity('abc').density).toBe(0)
    expect(computeDensity('كّّ').withMarks).toBe(1) // two marks, one letter
  })
})

describe('RunSession', () => {
  const src = 'كتب الولد. ذهب الرجل'
  const chunk = (id: number, start: number, end: number, text: string): StreamChunk => ({
    chunk_id: id,
    start,
    end,
    text,
    progress: 0,
    wps: 1,
    cached: 0
  })
  const c1 = chunk(1, 0, 10, 'كَتَبَ الوَلَدُ.')
  const c2 = chunk(2, 10, 20, ' ذَهَبَ الرَّجُلُ')

  it('applies chunks mapped through earlier edits; whole run undoes in ONE step', () => {
    let s = mk(src, 5)
    const sess = new RunSession(s, 0, src)
    const before = s.doc.toString()
    for (const c of [c1, c2]) {
      const spec = sess.applyChunk(s, c)
      expect(spec).not.toBeNull()
      s = run(s, spec!)
    }
    const final = s.doc.toString()
    expect(final).not.toBe(before)
    expect(stripMarks(final)).toBe(src)
    for (const spec of sess.finish(s)) s = run(s, spec)
    expect(s.doc.toString()).toBe(final)
    undo({ state: s, dispatch: (tr) => (s = s.update(tr).state) })
    expect(s.doc.toString()).toBe(before)
    redo({ state: s, dispatch: (tr) => (s = s.update(tr).state) })
    expect(s.doc.toString()).toBe(final)
  })

  it('skips a chunk whose target text no longer matches', () => {
    const s = mk('مختلف تماما')
    const sess = new RunSession(s, 0, 'مختلف تماما')
    expect(sess.applyChunk(s, chunk(1, 0, 11, 'كَتَبَ الوَلَدُ'))).toBeNull()
    expect(sess.skipped).toBe(1)
    expect(sess.finish(s)).toEqual([])
  })

  it('honours selection base offset and keeps the cursor', () => {
    const doc = 'xx كتب yy'
    let s = mk(doc, 8)
    const sess = new RunSession(s, 3, 'كتب')
    s = run(s, sess.applyChunk(s, chunk(1, 0, 3, 'كَتَبَ'))!)
    expect(s.doc.toString()).toBe('xx كَتَبَ yy')
    expect(s.doc.sliceString(s.selection.main.anchor)).toBe('y')
  })

  it('maps offsets given in code points past astral characters', () => {
    const text = '😀 كتب'
    const s = mk(text)
    const sess = new RunSession(s, 0, text)
    // python offsets: emoji=1 cp, space=1, كتب = 2..5
    const spec = sess.applyChunk(s, chunk(1, 2, 5, 'كَتَبَ'))
    expect(spec).not.toBeNull()
    expect(run(s, spec!).doc.toString()).toBe('😀 كَتَبَ')
  })

  it('re-applying already diacritized text is a no-op', () => {
    const s = mk('كَتَبَ')
    const sess = new RunSession(s, 0, 'كَتَبَ')
    expect(sess.applyChunk(s, chunk(1, 0, 6, 'كَتَبَ'))).toBeNull()
    expect(sess.skipped).toBe(0)
  })
})

describe('editorPaletteClass', () => {
  it('maps toggle/color/font to class (OFF never uses the COLR font)', () => {
    expect(editorPaletteClass('Amiri', false, 'emerald')).toBe('pal-off')
    expect(editorPaletteClass('Amiri', true, 'emerald')).toBe('pal-emerald')
    expect(editorPaletteClass('Amiri', true, 'amber')).toBe('pal-amber')
    expect(editorPaletteClass('Amiri', true, undefined)).toBe('pal-emerald')
    expect(editorPaletteClass('Cairo', true, 'amber')).toBe('pal-off')
  })
})

describe('document switch (regression: load must not be undoable)', () => {
  it('fresh state has empty history and undo is a no-op', () => {
    // document A with user edits and history
    let a = mk('كتاب جميل')
    a = run(a, { changes: { from: 0, to: 9, insert: 'نص مختلف' } })
    expect(undoDepth(a)).toBeGreaterThan(0)
    // switch to document B the way EditorPane does
    const b = createDocumentState('وثيقة أخرى', [history()])
    expect(undoDepth(b)).toBe(0)
    expect(redoDepth(b)).toBe(0)
    let st = b
    const handled = undo({ state: st, dispatch: (tr) => (st = st.update(tr).state) })
    expect(handled).toBe(false)
    expect(st.doc.toString()).toBe('وثيقة أخرى')
  })
  it('after a run on B, undo goes back to B text and never to A', () => {
    let s = createDocumentState('كتاب جميل', [history()])
    const sess = new RunSession(s, 0, 'كتاب جميل')
    const sp = sess.applyChunk(s, {
      chunk_id: 1,
      start: 0,
      end: 9,
      text: 'كَتابُ جَميلُ',
      progress: 100,
      wps: 1,
      cached: 0
    })!
    s = run(s, sp)
    for (const f of sess.finish(s)) s = run(s, f)
    expect(undoDepth(s)).toBe(1)
    undo({ state: s, dispatch: (tr) => (s = s.update(tr).state) })
    expect(s.doc.toString()).toBe('كتاب جميل')
    expect(undo({ state: s, dispatch: (tr) => (s = s.update(tr).state) })).toBe(false)
    expect(s.doc.toString()).toBe('كتاب جميل')
    redo({ state: s, dispatch: (tr) => (s = s.update(tr).state) })
    expect(s.doc.toString()).toBe('كَتابُ جَميلُ')
  })
})

describe('RunSession performance', () => {
  it('handles hundreds of chunks over a multi-line document quickly', () => {
    const text = ('كتاب جميل '.repeat(20) + '\n').repeat(2000)
    let s = mk(text)
    const sess = new RunSession(s, 0, text)
    const N = 500
    const t0 = performance.now()
    for (let st = 0; st < text.length; st += N) {
      const raw = text.slice(st, st + N)
      const sp = sess.applyChunk(s, {
        chunk_id: st,
        start: st,
        end: st + raw.length,
        text: raw.replace(/([\u0621-\u064A])/g, '$1\u064E'),
        progress: 0,
        wps: 0,
        cached: 0
      })
      if (sp) s = run(s, sp)
    }
    for (const f of sess.finish(s)) s = run(s, f)
    expect(performance.now() - t0).toBeLessThan(8000)
    expect(stripMarks(s.doc.toString())).toBe(text)
    undo({ state: s, dispatch: (tr) => (s = s.update(tr).state) })
    expect(s.doc.toString()).toBe(text)
  })
})
