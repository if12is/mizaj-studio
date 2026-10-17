import { makeCpToUtf16 } from '@renderer/editor/offsets'

export type LegalGroup = 'amounts' | 'terms' | 'clauses' | 'glossary'

export const GROUP_LABELS: Record<LegalGroup, string> = {
  amounts: 'المبالغ',
  terms: 'المصطلحات المعرَّفة',
  clauses: 'ترقيم البنود',
  glossary: 'المعجم القانوني'
}

export interface LegalIssue {
  id: string
  group: LegalGroup
  type: string
  message_ar: string
  from: number
  to: number
  /** exact text at [from,to) when the check ran (used to verify before applying a fix) */
  expected: string
  fix?: { insert: string; label: string }
  note?: string
}

interface Span {
  start: number
  end: number
}
type Raw = Span & { type?: string; kind?: string; message_ar?: string } & Record<string, unknown>

/** Normalize the four legal check responses into one jumpable list (UTF-16 positions). */
export function buildLegalIssues(
  text: string,
  r: {
    amounts?: { issues?: Raw[] }
    terms?: { issues?: Raw[] }
    clauses?: { issues?: Raw[]; suggestions?: Raw[] }
    glossary?: { issues?: Raw[] }
  }
): LegalIssue[] {
  const conv = makeCpToUtf16(text)
  const out: LegalIssue[] = []
  const mk = (
    group: LegalGroup,
    i: number,
    s: Raw,
    msg: string,
    extra: Partial<LegalIssue> = {}
  ): void => {
    const from = conv(s.start)
    const to = conv(s.end)
    out.push({
      id: `${group}:${i}`,
      group,
      type: String(s.type ?? s.kind ?? ''),
      message_ar: msg,
      from,
      to,
      expected: text.slice(from, to),
      ...extra
    })
  }
  ;(r.amounts?.issues ?? []).forEach((s, i) => {
    const exp = typeof s.expected_words === 'string' ? s.expected_words : ''
    mk('amounts', i, s, s.message_ar ?? '', exp ? { note: `الصيغة المتوقعة بالحروف: ${exp}` } : {})
  })
  ;(r.terms?.issues ?? []).forEach((s, i) => {
    const sug = typeof s.suggestion === 'string' ? s.suggestion : ''
    // zero-width spans cannot be replaced safely
    const fix =
      s.type === 'variant_form' && sug && s.end > s.start ? { insert: sug, label: sug } : undefined
    mk('terms', i, s, s.message_ar ?? '', fix ? { fix } : {})
  })
  ;(r.clauses?.issues ?? []).forEach((s, i) => mk('clauses', i, s, s.message_ar ?? ''))
  ;(r.clauses?.suggestions ?? []).forEach((s, i) => {
    if (s.type !== 'renumber_heading') return
    const to = String(s.to ?? s.insert ?? '')
    mk('clauses', 1000 + i, s, `إعادة ترقيم: ${String(s.reason ?? '')}`, {
      type: 'renumber_heading',
      fix: { insert: String(s.insert ?? ''), label: `${String(s.from ?? '')} ← ${to}` }
    })
  })
  ;(r.glossary?.issues ?? []).forEach((s, i) => {
    const pref = typeof s.preferred === 'string' ? s.preferred : ''
    mk(
      'glossary',
      i,
      s,
      s.message_ar ?? '',
      pref && s.end > s.start ? { fix: { insert: pref, label: pref } } : {}
    )
  })
  return out.sort((a, b) => a.from - b.from)
}

export function groupIssues(list: LegalIssue[]): { group: LegalGroup; items: LegalIssue[] }[] {
  return (Object.keys(GROUP_LABELS) as LegalGroup[])
    .map((g) => ({ group: g, items: list.filter((i) => i.group === g) }))
    .filter((g) => g.items.length)
}
