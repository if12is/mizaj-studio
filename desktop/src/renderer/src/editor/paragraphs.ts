import { hasArabic } from './arabic'

export interface ParaRange {
  from: number
  to: number
  text: string
}

interface LineDoc {
  lineAt(pos: number): { from: number; to: number; text: string; number: number }
  line(n: number): { from: number; to: number; text: string; number: number }
  lines: number
}

/**
 * Paragraphs to process (a paragraph = one document line, so mixed Arabic/English text
 * stays whole, whatever the bidi order). No selection: the paragraph at the cursor.
 * Selection: every paragraph it touches, clipped to the selection. Blank/non-Arabic skipped.
 */
export function paragraphsFor(doc: LineDoc, selFrom: number, selTo: number): ParaRange[] {
  const out: ParaRange[] = []
  if (selFrom === selTo) {
    const l = doc.lineAt(selFrom)
    return hasArabic(l.text) ? [{ from: l.from, to: l.to, text: l.text }] : []
  }
  const first = doc.lineAt(selFrom).number
  const last = doc.lineAt(selTo).number
  for (let n = first; n <= last; n++) {
    const l = doc.line(n)
    const from = Math.max(l.from, selFrom)
    const to = Math.min(l.to, selTo)
    const text = l.text.slice(from - l.from, to - l.from)
    if (to > from && hasArabic(text)) out.push({ from, to, text })
  }
  return out
}
