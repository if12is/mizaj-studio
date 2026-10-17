/** Pure model of spelling issues (no DOM): mapping API issues to marks/decorations. */
export type Severity = 'error' | 'warning' | 'info'

export interface SpellIssueRaw {
  word: string
  code: string
  category: string
  severity: Severity
  message_ar: string
  suggestions: string[]
  start16: number
  end16: number
}

export interface SpellMark {
  from: number
  to: number
  word: string
  code: string
  category: string
  severity: Severity
  message_ar: string
  suggestions: string[]
}

export const CATEGORY_LABELS: Record<string, string> = {
  spelling: 'إملائي',
  pattern: 'أخطاء شائعة',
  punctuation: 'ترقيم'
}

/** red = error, amber = warning, blue = info */
export function severityClass(s: Severity): string {
  return s === 'error' ? 'cm-spell-error' : s === 'warning' ? 'cm-spell-warning' : 'cm-spell-info'
}

/** Marks for a check run over a text slice that starts at document offset `base`. */
export function issuesToMarks(
  issues: SpellIssueRaw[],
  base: number,
  docLength: number
): SpellMark[] {
  const out: SpellMark[] = []
  for (const i of issues) {
    const from = base + i.start16
    const to = base + i.end16
    if (to <= from || to > docLength) continue
    out.push({
      from,
      to,
      word: i.word,
      code: i.code,
      category: i.category,
      severity: i.severity,
      message_ar: i.message_ar,
      suggestions: i.suggestions ?? []
    })
  }
  return out.sort((a, b) => a.from - b.from)
}

export interface DecoSpec {
  from: number
  to: number
  class: string
}

/** Decoration specs (sorted, non-overlapping first-wins) for the CM field. */
export function marksToDecoSpecs(marks: SpellMark[]): DecoSpec[] {
  const out: DecoSpec[] = []
  let last = -1
  for (const m of [...marks].sort((a, b) => a.from - b.from)) {
    if (m.from < last) continue
    out.push({ from: m.from, to: m.to, class: `cm-spell ${severityClass(m.severity)}` })
    last = m.to
  }
  return out
}

/** Replace the marks that overlap the re-checked ranges with the fresh ones. */
export function mergeMarks(
  old: SpellMark[],
  ranges: { from: number; to: number }[],
  fresh: SpellMark[]
): SpellMark[] {
  const inRange = (m: SpellMark): boolean => ranges.some((r) => m.from < r.to && m.to > r.from)
  return [...old.filter((m) => !inRange(m)), ...fresh].sort((a, b) => a.from - b.from)
}

/** Next/previous mark relative to a position, wrapping around. */
export function neighbourMark(marks: SpellMark[], pos: number, dir: 1 | -1): SpellMark | null {
  if (!marks.length) return null
  const sorted = [...marks].sort((a, b) => a.from - b.from)
  if (dir === 1) return sorted.find((m) => m.from > pos) ?? sorted[0]
  return [...sorted].reverse().find((m) => m.from < pos) ?? sorted[sorted.length - 1]
}
