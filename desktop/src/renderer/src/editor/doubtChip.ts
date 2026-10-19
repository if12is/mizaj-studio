/** Text model of the «الكلمات المشكوك فيها» accuracy chip (status bar). */
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
export const toArabicDigits = (n: number): string =>
  String(Math.max(0, Math.floor(n))).replace(/\d/g, (d) => AR_DIGITS[+d])

export interface DoubtState {
  active: boolean
  total: number
  remaining: number
  position?: number
}

export type DoubtView =
  | { kind: 'hidden' }
  | { kind: 'done'; text: string }
  | { kind: 'doubt'; text: string; position: string | null }

export function doubtView(r: DoubtState): DoubtView {
  if (r.total <= 0) return { kind: 'hidden' }
  if (r.remaining <= 0) return { kind: 'done', text: 'تمت المراجعة ✓' }
  const pos =
    r.active && r.position && r.position > 0
      ? `${toArabicDigits(r.position)} / ${toArabicDigits(r.total)}`
      : null
  return { kind: 'doubt', text: `الكلمات المشكوك فيها: ${r.remaining}`, position: pos }
}
