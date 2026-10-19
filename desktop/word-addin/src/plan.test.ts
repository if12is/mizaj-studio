import { describe, expect, it } from 'vitest'
import { applyEdits, diffText, type TextEdit } from '../../src/main/systemwide/textDiff'
import { applyOps, charsMatch, classifyParagraph, planParagraph } from './plan'

const FATHA = 'َ'
const DAMMA = 'ُ'
const SHADDA = 'ّ'

/**
 * A Word-like paragraph: each character carries the formatting of its run. The simulation applies
 * the ops the way Word does (replacement and insertions inherit the formatting of the character
 * they are attached to) so formatting preservation can be checked on the pure level.
 */
interface Cell {
  ch: string
  fmt: string
}
function runsToCells(runs: [string, string][]): Cell[] {
  return runs.flatMap(([t, fmt]) => t.split('').map((ch) => ({ ch, fmt })))
}
function simulate(cells: Cell[], ops: ReturnType<typeof planParagraph>): Cell[] {
  const out = cells.map((c) => [c] as Cell[])
  for (const op of ops ?? []) {
    const c = cells[op.index]
    if (op.kind === 'delete') out[op.index] = []
    else if (op.kind === 'replace')
      out[op.index] = op.text.split('').map((ch) => ({ ch, fmt: c.fmt }))
    else if (op.kind === 'after')
      out[op.index] = [c, ...op.text.split('').map((ch) => ({ ch, fmt: c.fmt }))]
    else out[op.index] = [...op.text.split('').map((ch) => ({ ch, fmt: c.fmt })), c]
  }
  return out.flat()
}
const runsOf = (cells: Cell[]): [string, string][] => {
  const r: [string, string][] = []
  for (const c of cells) {
    const last = r[r.length - 1]
    if (last && last[1] === c.fmt) last[0] += c.ch
    else r.push([c.ch, c.fmt])
  }
  return r
}

describe('planParagraph', () => {
  it('attaches inserted marks after their base letter', () => {
    const text = 'كتاب'
    const edits: TextEdit[] = [
      { start: 1, end: 1, insert: FATHA },
      { start: 4, end: 4, insert: DAMMA }
    ]
    expect(planParagraph(text, edits)).toEqual([
      { index: 3, kind: 'after', text: DAMMA },
      { index: 0, kind: 'after', text: FATHA }
    ])
  })
  it('an insertion at the very start anchors before the first character', () => {
    expect(planParagraph('كتاب', [{ start: 0, end: 0, insert: ' ' }])).toEqual([
      { index: 0, kind: 'before', text: ' ' }
    ])
  })
  it('replaces letters pairwise, deletes surplus, appends surplus to the last replaced', () => {
    expect(planParagraph('اأب', [{ start: 1, end: 2, insert: 'ء' }])).toEqual([
      { index: 1, kind: 'replace', text: 'ء' }
    ])
    expect(planParagraph('abcd', [{ start: 1, end: 3, insert: 'X' }])).toEqual([
      { index: 2, kind: 'delete' },
      { index: 1, kind: 'replace', text: 'X' }
    ])
    expect(planParagraph('abcd', [{ start: 1, end: 2, insert: 'XYZ' }])).toEqual([
      { index: 1, kind: 'replace', text: 'XYZ' }
    ])
  })
  it('merges edits touching the same character into one operation', () => {
    const ops = planParagraph('abc', [
      { start: 1, end: 2, insert: 'X' },
      { start: 2, end: 2, insert: 'Y' }
    ])
    expect(ops).toEqual([{ index: 1, kind: 'replace', text: 'XY' }])
  })
  it('refuses what cannot be anchored', () => {
    expect(planParagraph('', [{ start: 0, end: 0, insert: 'x' }])).toBeNull()
    expect(planParagraph('ab', [{ start: 1, end: 9, insert: '' }])).toBeNull()
    expect(
      planParagraph('ab', [
        { start: 1, end: 1, insert: 'x' },
        { start: 0, end: 0, insert: 'y' }
      ])
    ).toBeNull()
    expect(planParagraph('ab', [{ start: 0, end: 1, insert: '\ud83d' }])).toBeNull()
  })
  it('no edits, no ops', () => {
    expect(planParagraph('كتاب', [])).toEqual([])
  })
})

describe('plans reproduce the processed text and keep formatting', () => {
  const cases: [string, string][] = [
    ['كتاب جميل', 'كِتابٌ جَميلٌ'],
    ['مدرسة', 'مَدْرَسَةٌ'],
    ['انا ذهبت الى المدرسه', 'أنا ذهبتُ إلى المدرسةِ'],
    ['هذا , نص', 'هذا، نص'],
    ['الشّمس', 'الشَّمسُ'],
    ['x', 'x'],
    ['', '']
  ]
  for (const [a, b] of cases) {
    it(`${a || '(empty)'} -> ${b || '(empty)'}`, () => {
      const edits = diffText(a, b)
      const ops = planParagraph(a, edits)
      expect(ops).not.toBeNull()
      expect(applyOps(a, ops ?? [])).toBe(b)
      expect(applyOps(a, ops ?? [])).toBe(applyEdits(a, edits))
    })
  }

  it('every untouched character keeps its run; marks take their letter run (tashkeel on mixed runs)', () => {
    // "كتاب" bold + "جميل" regular, separated by a bold space, with a colored word at the end
    const cells = runsToCells([
      ['كتاب ', 'bold'],
      ['جميل ', 'plain'],
      ['جدا', 'red']
    ])
    const text = cells.map((c) => c.ch).join('')
    const target = 'كِتابٌ جَمِيلٌ جِدّاً'
    const ops = planParagraph(text, diffText(text, target))
    const out = simulate(cells, ops)
    expect(out.map((c) => c.ch).join('')).toBe(target)
    // every character of the result keeps the run of the original character it came from
    expect(runsOf(out)).toEqual([
      ['كِتابٌ ', 'bold'],
      ['جَمِيلٌ ', 'plain'],
      ['جِدّاً', 'red']
    ])
  })

  it('a word split across two runs keeps both runs', () => {
    const cells = runsToCells([
      ['كت', 'bold'],
      ['اب', 'italic']
    ])
    const out = simulate(cells, planParagraph('كتاب', diffText('كتاب', 'كَتَابٌ')))
    expect(out.map((c) => c.ch).join('')).toBe('كَتَابٌ')
    expect(runsOf(out)).toEqual([
      ['كَتَ', 'bold'],
      ['ابٌ', 'italic']
    ])
  })

  it('removing existing marks and changing letters stay inside their runs', () => {
    const cells = runsToCells([
      ['الشَّ', 'a'],
      ['مس', 'b']
    ])
    const text = cells.map((c) => c.ch).join('')
    const target = 'الشمس'
    const out = simulate(cells, planParagraph(text, diffText(text, target)))
    expect(out.map((c) => c.ch).join('')).toBe(target)
    expect(runsOf(out)).toEqual([
      ['الش', 'a'],
      ['مس', 'b']
    ])
    expect(text).toContain(SHADDA)
  })
})

describe('guards', () => {
  it('classifies paragraphs that must not be touched', () => {
    expect(classifyParagraph({ text: 'كتاب', fields: 0, contentControls: 0 })).toBeNull()
    expect(classifyParagraph({ text: '  ', fields: 0, contentControls: 0 })).toBe('empty')
    expect(classifyParagraph({ text: 'كتاب', fields: 1, contentControls: 0 })).toBe('field')
    expect(classifyParagraph({ text: 'كتاب', fields: 0, contentControls: 2 })).toBe(
      'content_control'
    )
    expect(classifyParagraph({ text: 'ك\u0013تاب', fields: 0, contentControls: 0 })).toBe('special')
  })
  it('charsMatch demands one range per UTF-16 unit with the same text', () => {
    expect(charsMatch('كتاب', ['ك', 'ت', 'ا', 'ب'])).toBe(true)
    expect(charsMatch('كتاب', ['ك', 'ت', 'ا'])).toBe(false)
    expect(charsMatch('كتاب', ['ك', 'ت', 'ا', 'ة'])).toBe(false)
    expect(charsMatch('a😀', ['a', '😀'])).toBe(false) // Word counting a pair as one: refuse
  })
})
