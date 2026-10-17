import { makeCpToUtf16 } from '@renderer/editor/offsets'

/** A replacement that is only valid while `text.slice(from,to) === expected`. */
export interface TextEdit {
  from: number
  to: number
  expected: string
  insert: string
}

export interface ApplyResult {
  text: string
  applied: number
  skipped: number
}

/** Keep edits that still match `text` and do not overlap an earlier one. Sorted by position. */
export function validEdits(text: string, edits: TextEdit[]): { ok: TextEdit[]; skipped: number } {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to)
  const ok: TextEdit[] = []
  let end = -1
  let skipped = 0
  for (const e of sorted) {
    const fits =
      e.from >= 0 &&
      e.to >= e.from &&
      e.to <= text.length &&
      text.slice(e.from, e.to) === e.expected
    if (!fits || e.from < end) {
      skipped++
      continue
    }
    ok.push(e)
    end = e.to
  }
  return { ok, skipped }
}

/** Apply all still-valid edits to a string (used for the redacted COPY of a document). */
export function applyTextEdits(text: string, edits: TextEdit[]): ApplyResult {
  const { ok, skipped } = validEdits(text, edits)
  let out = ''
  let pos = 0
  for (const e of ok) {
    out += text.slice(pos, e.from) + e.insert
    pos = e.to
  }
  out += text.slice(pos)
  return { text: out, applied: ok.length, skipped }
}

/**
 * Collapse many edits into ONE replacement spanning min(from)..max(to), so the editor can apply
 * them as a single verified transaction (one undo step) through its single-range helper.
 */
export function combineEdits(
  text: string,
  edits: TextEdit[]
): { edit: TextEdit; applied: number; skipped: number } | null {
  const { ok, skipped } = validEdits(text, edits)
  if (!ok.length) return null
  const from = ok[0].from
  const to = ok[ok.length - 1].to
  const slice = text.slice(from, to)
  const rel = ok.map((e) => ({ ...e, from: e.from - from, to: e.to - from }))
  const { text: insert } = applyTextEdits(slice, rel)
  return { edit: { from, to, expected: slice, insert }, applied: ok.length, skipped }
}

export interface UtfSpan {
  from: number
  to: number
  text: string
}

/** Convert a backend code-point span to a UTF-16 span with the text it covers. */
export function toSpan(
  text: string,
  conv: (cp: number) => number,
  start: number,
  end: number
): UtfSpan {
  const from = conv(start)
  const to = conv(end)
  return { from, to, text: text.slice(from, to) }
}

// ------------------------------------------------------------------ lint
export interface RawLintIssue {
  rule: string
  severity: 'error' | 'warning' | 'info'
  start: number
  end: number
  text: string
  message_ar: string
  modalities?: string[]
}

export interface LintIssue extends UtfSpan {
  id: string
  rule: string
  severity: RawLintIssue['severity']
  message_ar: string
}

export const SEVERITY_LABEL: Record<string, string> = {
  error: 'خطأ',
  warning: 'تحذير',
  info: 'ملاحظة'
}

export function buildLintIssues(text: string, raw: RawLintIssue[]): LintIssue[] {
  const conv = makeCpToUtf16(text)
  return raw
    .map((r, i) => ({
      id: `lint:${i}`,
      rule: r.rule,
      severity: r.severity,
      message_ar: r.message_ar,
      ...toSpan(text, conv, r.start, r.end)
    }))
    .sort((a, b) => a.from - b.from)
}

export function groupByRule(issues: LintIssue[]): { rule: string; items: LintIssue[] }[] {
  const m = new Map<string, LintIssue[]>()
  for (const i of issues) m.set(i.rule, [...(m.get(i.rule) ?? []), i])
  return [...m].map(([rule, items]) => ({ rule, items }))
}

export const MODALITY_LABEL: Record<string, string> = {
  obligation: 'التزام',
  permission: 'إذن',
  prohibition: 'حظر'
}

/** Number of sentences carrying each modality (a sentence with two kinds counts in both). */
export function modalityCounts(
  list: { kinds: string[] }[]
): { kind: string; label: string; count: number }[] {
  const c: Record<string, number> = {}
  for (const s of list) for (const k of s.kinds) c[k] = (c[k] ?? 0) + 1
  return Object.keys(MODALITY_LABEL).map((k) => ({
    kind: k,
    label: MODALITY_LABEL[k],
    count: c[k] ?? 0
  }))
}

// ------------------------------------------------------------------ redaction
export interface RawRedaction {
  id: number
  category: string
  kind: string
  start: number
  end: number
  original: string
  replacement: string
  confidence: 'high' | 'medium' | 'low'
  note: string
}

export interface RedactionEdit extends TextEdit {
  id: number
  category: string
  confidence: RawRedaction['confidence']
  note: string
  replacement: string
}

export const REDACT_CATEGORIES: [string, string][] = [
  ['id', 'رقم هوية'],
  ['phone', 'هاتف'],
  ['email', 'بريد إلكتروني'],
  ['iban', 'آيبان'],
  ['card', 'بطاقة بنكية'],
  ['passport', 'جواز سفر'],
  ['name', 'اسم'],
  ['party', 'طرف في العقد']
]
export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(REDACT_CATEGORIES)
export const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'ثقة عالية',
  medium: 'ثقة متوسطة',
  low: 'ثقة منخفضة'
}

export function buildRedactionEdits(text: string, raw: RawRedaction[]): RedactionEdit[] {
  const conv = makeCpToUtf16(text)
  return raw.map((r) => {
    const s = toSpan(text, conv, r.start, r.end)
    return {
      id: r.id,
      category: r.category,
      confidence: r.confidence,
      note: r.note,
      replacement: r.replacement,
      from: s.from,
      to: s.to,
      expected: s.text,
      insert: r.replacement
    }
  })
}

/** Low-confidence proposals start unchecked: the user must opt in. */
export const defaultSelection = (edits: RedactionEdit[]): number[] =>
  edits.filter((e) => e.confidence !== 'low').map((e) => e.id)

export interface MappingRow {
  replacement: string
  category: string
  original: string
  count: number
}

export function buildMapping(edits: RedactionEdit[]): MappingRow[] {
  const m = new Map<string, MappingRow>()
  for (const e of edits) {
    const k = `${e.replacement}\u0000${e.expected}`
    const row = m.get(k)
    if (row) row.count++
    else
      m.set(k, { replacement: e.replacement, category: e.category, original: e.expected, count: 1 })
  }
  return [...m.values()]
}

/** CSV (UTF-8, quoted) of the mapping table; kept local, never uploaded. */
export function mappingToCsv(rows: MappingRow[]): string {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`
  const head = ['replacement', 'category', 'original', 'count'].map(q).join(',')
  return [
    head,
    ...rows.map((r) => [r.replacement, r.category, r.original, String(r.count)].map(q).join(','))
  ].join('\r\n')
}

// ------------------------------------------------------------------ citations
export interface RawCitationSuggestion {
  kind: string
  start: number
  end: number
  original: string
  suggested: string
}

export function buildCitationEdits(
  text: string,
  raw: RawCitationSuggestion[]
): (TextEdit & { kind: string })[] {
  const conv = makeCpToUtf16(text)
  return raw.map((r) => {
    const s = toSpan(text, conv, r.start, r.end)
    return { kind: r.kind, from: s.from, to: s.to, expected: s.text, insert: r.suggested }
  })
}

// ------------------------------------------------------------------ compare
export interface CmpSide {
  start: number
  end: number
  text: string
}
export interface CmpHunk {
  index: number
  type: 'insert' | 'delete' | 'replace' | 'format_only'
  a: CmpSide | null
  b: CmpSide | null
  categories: string[]
}
export interface CmpRow {
  status: 'equal' | 'changed' | 'added' | 'removed' | 'format_only'
  a: CmpSide | null
  b: CmpSide | null
  hunks: number[]
}
export interface Segment {
  text: string
  kind: 'same' | 'change' | 'format'
}

export const CATEGORY_AR: Record<string, string> = {
  numbers: 'أرقام',
  amounts: 'مبالغ',
  dates: 'تواريخ',
  parties: 'أطراف',
  obligations: 'التزامات',
  negation: 'نفي'
}

/** Split one aligned side into highlighted segments. Hunk offsets are code points into the full text. */
export function sideSegments(
  side: CmpSide | null,
  which: 'a' | 'b',
  hunks: CmpHunk[],
  hunkIds: number[],
  showFormat: boolean
): Segment[] {
  if (!side) return []
  const conv = makeCpToUtf16(side.text)
  const marks: { from: number; to: number; kind: Segment['kind'] }[] = []
  for (const id of hunkIds) {
    const h = hunks[id]
    const part = h?.[which]
    if (!part) continue
    if (h.type === 'format_only' && !showFormat) continue
    marks.push({
      from: conv(part.start - side.start),
      to: conv(part.end - side.start),
      kind: h.type === 'format_only' ? 'format' : 'change'
    })
  }
  marks.sort((x, y) => x.from - y.from)
  const out: Segment[] = []
  let pos = 0
  for (const m of marks) {
    if (m.from < pos) continue
    if (m.from > pos) out.push({ text: side.text.slice(pos, m.from), kind: 'same' })
    out.push({ text: side.text.slice(m.from, m.to), kind: m.kind })
    pos = m.to
  }
  if (pos < side.text.length) out.push({ text: side.text.slice(pos), kind: 'same' })
  return out
}

/** Rows to show: format-only differences and unchanged paragraphs are hidden unless asked for. */
export function visibleRows(
  rows: CmpRow[],
  opts: { showFormat: boolean; showEqual: boolean }
): CmpRow[] {
  return rows.filter((r) => {
    if (r.status === 'equal') return opts.showEqual
    if (r.status === 'format_only') return opts.showFormat
    return true
  })
}
