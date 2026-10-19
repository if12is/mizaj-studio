import { makeCpToUtf16 } from '@renderer/editor/offsets'

export interface CardSpan {
  start: number
  end: number
}
export interface CardItem extends CardSpan {
  text: string
  confidence: number
  [k: string]: unknown
}
export interface CardField extends CardSpan {
  key: string
  label_ar: string
  value: string
  confidence: number
  occurrences?: CardSpan[]
  items?: CardItem[]
}

/** The backend reports code-point offsets; CodeMirror wants UTF-16 offsets. */
export function toEditorOffsets(text: string, fields: CardField[]): CardField[] {
  const conv = makeCpToUtf16(text)
  const sp = <T extends CardSpan>(s: T): T => ({ ...s, start: conv(s.start), end: conv(s.end) })
  return fields.map((f) => ({
    ...sp(f),
    occurrences: f.occurrences?.map(sp),
    items: f.items?.map(sp)
  }))
}

export type Level = 'high' | 'mid' | 'low'
export function confidenceLevel(c: number): Level {
  return c >= 0.85 ? 'high' : c >= 0.65 ? 'mid' : 'low'
}
export const LEVEL_LABEL: Record<Level, string> = {
  high: 'ثقة عالية',
  mid: 'ثقة متوسطة',
  low: 'ثقة منخفضة'
}

/** Every place a field can jump to: its items, else its occurrences, else its own span. */
export function jumpTargets(f: CardField): CardSpan[] {
  if (f.items?.length) return f.items
  if (f.occurrences?.length) return f.occurrences
  return [f]
}

export function fieldCopyText(f: CardField): string {
  return f.value
}
export function allCopyText(fields: CardField[]): string {
  return fields
    .map((f) =>
      f.value.includes('\n') ? `${f.label_ar}:\n${f.value}` : `${f.label_ar}: ${f.value}`
    )
    .join('\n')
}

const KEY = 'mizaj.casecard.hidden.'
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
function store(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
export function isHidden(docId: number | null | undefined, s: Store | null = store()): boolean {
  if (docId == null || !s) return false
  try {
    return s.getItem(KEY + docId) === '1'
  } catch {
    return false
  }
}
export function setHidden(
  docId: number | null | undefined,
  hidden: boolean,
  s: Store | null = store()
): void {
  if (docId == null || !s) return
  try {
    if (hidden) s.setItem(KEY + docId, '1')
    else s.removeItem(KEY + docId)
  } catch {
    /* storage unavailable: the card just reappears next time */
  }
}
