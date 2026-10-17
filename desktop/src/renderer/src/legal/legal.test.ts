import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { cpToUtf16, makeCpToUtf16 } from '@renderer/editor/offsets'
import { insertAtCursorSpec, safeEditSpec } from '@renderer/editor/safeEdit'
import {
  issuesToMarks,
  marksToDecoSpecs,
  mergeMarks,
  neighbourMark,
  severityClass,
  type SpellIssueRaw
} from '@renderer/editor/spellModel'
import {
  clearSpellMarks,
  removeSpellWord,
  setSpellMarks,
  spellField
} from '@renderer/editor/spelling'
import { buildLegalIssues, groupIssues } from './issues'
import {
  buildValues,
  errorMap,
  initialFormState,
  rowsToVars,
  varsToRows,
  type TemplateVar
} from './templateForm'

describe('code point -> UTF-16 offsets', () => {
  const text = '😀 المبلغ 😀😀 1500'
  it('is identity for BMP-only text', () => {
    expect(cpToUtf16('مرحبا بكم', 4)).toBe(4)
  })
  it('shifts by one per astral character before the offset', () => {
    const cp = [...text]
    const i = cp.indexOf('1') // code point index of "1"
    expect(i).toBeLessThan(text.indexOf('1')) // cp index < utf16 index (4 astral chars)
    expect(cpToUtf16(text, i)).toBe(text.indexOf('1'))
    expect(cpToUtf16(text, 1)).toBe(2) // right after the first emoji
    expect(cpToUtf16(text, cp.length)).toBe(text.length)
    const conv = makeCpToUtf16(text)
    expect(text.slice(conv(2), conv(8))).toBe(cp.slice(2, 8).join(''))
  })
  it('clamps out-of-range offsets', () => {
    expect(cpToUtf16(text, 999)).toBe(text.length)
    expect(cpToUtf16(text, -3)).toBe(0)
  })
})

describe('safe edit (suggestion acceptance)', () => {
  const mk = (doc: string) => EditorState.create({ doc })
  it('replaces exactly [from,to) when the text still matches', () => {
    const s = mk('ذهبت الى المدرسه')
    const spec = safeEditSpec(s, 5, 8, 'الى', 'إلى', 'spelling.accept')!
    const n = s.update(spec).state
    expect(n.doc.toString()).toBe('ذهبت إلى المدرسه')
    expect(n.selection.main.head).toBe(8)
  })
  it('refuses when the text changed underneath (stale suggestion)', () => {
    const s = mk('ذهبت الى المدرسه')
    expect(safeEditSpec(s, 5, 8, 'اني', 'إلى', 'x')).toBeNull()
    expect(safeEditSpec(s, 5, 99, 'الى', 'إلى', 'x')).toBeNull()
    expect(safeEditSpec(s, -1, 2, 'ذه', 'x', 'x')).toBeNull()
  })
  it('insert at cursor replaces the selection in one transaction', () => {
    const s = EditorState.create({ doc: 'abc XYZ def', selection: { anchor: 4, head: 7 } })
    const n = s.update(insertAtCursorSpec(s, 'ألف', 'input.legal')).state
    expect(n.doc.toString()).toBe('abc ألف def')
  })
})

describe('issue -> decoration mapping', () => {
  const raw = (o: Partial<SpellIssueRaw>): SpellIssueRaw => ({
    word: 'الى',
    code: 'HAMZA_QAT',
    category: 'pattern',
    severity: 'error',
    message_ar: 'm',
    suggestions: ['إلى'],
    start16: 5,
    end16: 8,
    ...o
  })
  it('uses start16/end16 + base and picks colours by severity', () => {
    const marks = issuesToMarks(
      [
        raw({}),
        raw({ severity: 'warning', start16: 10, end16: 14 }),
        raw({ severity: 'info', start16: 20, end16: 22 })
      ],
      100,
      1000
    )
    expect(marks.map((m) => [m.from, m.to])).toEqual([
      [105, 108],
      [110, 114],
      [120, 122]
    ])
    expect(marksToDecoSpecs(marks).map((d) => d.class)).toEqual([
      'cm-spell cm-spell-error',
      'cm-spell cm-spell-warning',
      'cm-spell cm-spell-info'
    ])
    expect(severityClass('error')).toBe('cm-spell-error')
  })
  it('drops empty or out-of-range issues and overlapping decorations', () => {
    expect(
      issuesToMarks([raw({ start16: 3, end16: 3 }), raw({ start16: 5, end16: 99 })], 0, 50)
    ).toEqual([])
    const m = issuesToMarks([raw({ start16: 0, end16: 5 }), raw({ start16: 3, end16: 8 })], 0, 50)
    expect(marksToDecoSpecs(m)).toHaveLength(1)
  })
  it('re-check replaces marks only inside the checked ranges', () => {
    const a = issuesToMarks(
      [raw({ start16: 0, end16: 3 }), raw({ start16: 40, end16: 43 })],
      0,
      100
    )
    const fresh = issuesToMarks([raw({ start16: 1, end16: 4 })], 0, 100)
    const merged = mergeMarks(a, [{ from: 0, to: 20 }], fresh)
    expect(merged.map((m) => [m.from, m.to])).toEqual([
      [1, 4],
      [40, 43]
    ])
  })
  it('next/prev wrap around', () => {
    const marks = issuesToMarks(
      [raw({ start16: 5, end16: 8 }), raw({ start16: 20, end16: 24 })],
      0,
      100
    )
    expect(neighbourMark(marks, 5, 1)?.from).toBe(20)
    expect(neighbourMark(marks, 20, 1)?.from).toBe(5)
    expect(neighbourMark(marks, 5, -1)?.from).toBe(20)
    expect(neighbourMark(marks, 30, -1)?.from).toBe(20)
    expect(neighbourMark([], 0, 1)).toBeNull()
  })
})

describe('spell state field', () => {
  const doc = 'ذهبت الى المدرسه'
  const base = (): EditorState => EditorState.create({ doc, extensions: [spellField] })
  const marks = issuesToMarks(
    [
      {
        word: 'الى',
        code: 'A',
        category: 'pattern',
        severity: 'error',
        message_ar: '',
        suggestions: [],
        start16: 5,
        end16: 8
      },
      {
        word: 'المدرسه',
        code: 'B',
        category: 'pattern',
        severity: 'warning',
        message_ar: '',
        suggestions: [],
        start16: 9,
        end16: 16
      }
    ],
    0,
    doc.length
  )
  it('follows edits before the word and drops marks whose word was edited', () => {
    let s = base().update({
      effects: setSpellMarks.of({ ranges: [{ from: 0, to: doc.length }], marks })
    }).state
    expect(s.field(spellField)).toHaveLength(2)
    s = s.update({ changes: { from: 0, insert: 'قال ' } }).state
    expect(s.field(spellField).map((m) => m.from)).toEqual([9, 13])
    s = s.update({ changes: { from: 10, to: 11, insert: 'x' } }).state // inside الى
    expect(s.field(spellField).map((m) => m.word)).toEqual(['المدرسه'])
  })
  it('ignore-by-word and clear effects', () => {
    let s = base().update({
      effects: setSpellMarks.of({ ranges: [{ from: 0, to: 99 }], marks })
    }).state
    s = s.update({ effects: removeSpellWord.of('الى') }).state
    expect(s.field(spellField).map((m) => m.word)).toEqual(['المدرسه'])
    s = s.update({ effects: clearSpellMarks.of(null) }).state
    expect(s.field(spellField)).toEqual([])
  })
})

describe('legal issues (offsets, fixes)', () => {
  it('converts code-point offsets and verifies expected text, with astral chars', () => {
    const text = '😀😀 المبلغ 1500 (ألف وستمائة جنيه) يدفع'
    const cp = [...text]
    const start = cp.indexOf('1')
    const end = cp.length - [...' يدفع'].length
    const issues = buildLegalIssues(text, {
      amounts: {
        issues: [
          {
            kind: 'mismatch',
            start,
            end,
            message_ar: 'تعارض',
            expected_words: 'ألف وخمسمائة'
          } as never
        ]
      }
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].expected).toBe('1500 (ألف وستمائة جنيه)')
    expect(text.slice(issues[0].from, issues[0].to)).toBe(issues[0].expected)
    expect(issues[0].fix).toBeUndefined() // never auto-fix amounts
    expect(issues[0].note).toContain('ألف وخمسمائة')
  })
  it('maps renumber, variant_form and glossary suggestions to single edits', () => {
    const text = 'المادة 1\nالمادة 3\nكلام الغبن العادي هنا'
    const i3 = text.indexOf('3')
    const g = text.indexOf('الغبن العادي')
    const issues = buildLegalIssues(text, {
      clauses: {
        issues: [{ type: 'gap', start: 9, end: 17, message_ar: 'gap' } as never],
        suggestions: [
          {
            type: 'renumber_heading',
            start: i3,
            end: i3 + 1,
            from: '3',
            insert: '2',
            to: '2',
            reason: 'مادة 3 -> 2'
          } as never
        ]
      },
      terms: {
        issues: [
          {
            type: 'variant_form',
            start: 0,
            end: 5,
            found: 'المادة',
            suggestion: 'المادّة',
            message_ar: 'v'
          } as never,
          { type: 'variant_form', start: 4, end: 4, suggestion: 'x', message_ar: 'zero' } as never,
          { type: 'undefined_term', start: 0, end: 3, message_ar: 'u' } as never
        ]
      },
      glossary: {
        issues: [
          {
            type: 'avoid_term',
            start: g,
            end: g + 12,
            preferred: 'الغبن الفاحش',
            message_ar: 'g'
          } as never
        ]
      }
    })
    const fixes = issues.filter((i) => i.fix)
    expect(fixes.map((i) => i.type).sort()).toEqual([
      'avoid_term',
      'renumber_heading',
      'variant_form'
    ])
    const renumber = fixes.find((i) => i.type === 'renumber_heading')!
    expect(renumber.expected).toBe('3')
    expect(renumber.fix).toEqual({ insert: '2', label: '3 ← 2' })
    // applying through safeEditSpec changes exactly that digit
    const s = EditorState.create({ doc: text })
    const n = s.update(
      safeEditSpec(s, renumber.from, renumber.to, renumber.expected, '2', 'legal.apply')!
    ).state
    expect(n.doc.toString()).toBe('المادة 1\nالمادة 2\nكلام الغبن العادي هنا')
    expect(groupIssues(issues).map((x) => x.group)).toEqual(['terms', 'clauses', 'glossary'])
  })
})

describe('template form values', () => {
  const vars: TemplateVar[] = [
    { name: 'المؤجر', type: 'party', required: true },
    { name: 'الأجرة', type: 'money', required: true, currency: 'EGP' },
    { name: 'تاريخ', type: 'date' },
    { name: 'شرط', type: 'choice', choices: ['نعم', 'لا'], default: 'لا' },
    { name: 'ملاحظة', type: 'text', required: false }
  ]
  it('prefills defaults and builds values omitting empty fields', () => {
    const f = initialFormState(vars)
    expect(f['شرط']).toBe('لا')
    expect(buildValues(vars, f)).toEqual({ شرط: 'لا' })
    ;(f['المؤجر'] as Record<string, string>).name = '  أحمد  '
    ;(f['المؤجر'] as Record<string, string>).id_number = '123'
    f['الأجرة'] = ' 1500 '
    expect(buildValues(vars, f)).toEqual({
      المؤجر: { name: 'أحمد', id_number: '123' },
      الأجرة: '1500',
      شرط: 'لا'
    })
  })
  it('maps server errors to Arabic per field (first error wins)', () => {
    const m = errorMap([
      { var: 'الأجرة', code: 'invalid_amount', message: 'x' },
      { var: 'الأجرة', code: 'missing', message: 'y' },
      { var: 'المؤجر', code: 'missing', message: 'z' },
      { var: 'ق', code: 'other', message: 'raw message' }
    ])
    expect(m['الأجرة']).toBe('مبلغ غير صالح')
    expect(m['المؤجر']).toBe('هذا الحقل مطلوب')
    expect(m['ق']).toBe('raw message')
  })
  it('editor rows round-trip to API vars', () => {
    const rows = varsToRows(vars)
    const back = rowsToVars(rows)
    expect(back.find((v) => v.name === 'شرط')?.choices).toEqual(['نعم', 'لا'])
    expect(back.find((v) => v.name === 'الأجرة')?.currency).toBe('EGP')
    expect(back.find((v) => v.name === 'ملاحظة')?.required).toBe(false)
  })
})
