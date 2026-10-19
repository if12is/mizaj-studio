/** Pure helpers for the edit-history panel «سجل التعديلات» (no DOM, no stores). */

export type VersionKind = 'autosave' | 'event' | 'checkpoint' | 'restore' | 'initial'

export interface VersionMeta {
  id: number
  document_id: number
  created_at: string
  updated_at: string
  kind: VersionKind
  label: string
  name: string
  char_count: number
  word_count: number
  words_added: number
  words_removed: number
  chars_delta: number
}

export interface DiffOp {
  op: 'equal' | 'insert' | 'delete'
  text: string
}

/** Western digits to Arabic-Indic digits. */
export function arDigits(v: number | string): string {
  return String(v).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Local calendar day key `YYYY-MM-DD` of an ISO timestamp. */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Local time `HH:MM` (24h) in Arabic-Indic digits. */
export function timeLabel(iso: string): string {
  const d = new Date(iso)
  return arDigits(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`)
}

export function dayLabel(key: string, now: Date = new Date()): string {
  if (key === dayKey(now.toISOString())) return 'اليوم'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (key === dayKey(y.toISOString())) return 'أمس'
  const [yy, mm, dd] = key.split('-').map(Number)
  return arDigits(`${yy}-${pad2(mm)}-${pad2(dd)}`)
}

export interface DayGroup {
  key: string
  label: string
  items: VersionMeta[]
}

/** Group a newest-first list by local day, keeping the order. */
export function groupByDay(items: VersionMeta[], now: Date = new Date()): DayGroup[] {
  const out: DayGroup[] = []
  for (const it of items) {
    const key = dayKey(it.created_at)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(it)
    else out.push({ key, label: dayLabel(key, now), items: [it] })
  }
  return out
}

/** «+٣» / «−١» word counts of an entry. */
export function deltaLabels(v: Pick<VersionMeta, 'words_added' | 'words_removed'>): {
  plus: string
  minus: string
} {
  return { plus: `+${arDigits(v.words_added)}`, minus: `−${arDigits(v.words_removed)}` }
}

export function entryTitle(v: Pick<VersionMeta, 'label' | 'name'>): string {
  return v.name ? `${v.label}: «${v.name}»` : v.label
}

/** Label recorded for a restore, e.g. «استعادة نسخة ١٤:٣٠» (with the day when not today). */
export function restoreLabel(v: Pick<VersionMeta, 'created_at'>, now: Date = new Date()): string {
  const key = dayKey(v.created_at)
  const day = key === dayKey(now.toISOString()) ? '' : `${dayLabel(key, now)} `
  return `استعادة نسخة ${day}${timeLabel(v.created_at)}`
}

/** «قبول ٥ اقتراحات تدقيق» with the right Arabic number agreement. */
export function acceptedLabel(n: number): string {
  if (n === 1) return 'قبول اقتراح تدقيق واحد'
  if (n === 2) return 'قبول اقتراحي تدقيق'
  if (n >= 3 && n <= 10) return `قبول ${arDigits(n)} اقتراحات تدقيق`
  return `قبول ${arDigits(n)} اقتراح تدقيق`
}

export function replaceAllLabel(n: number): string {
  return `استبدال الكل (${arDigits(n)} موضع)`
}

export const EVENT_LABELS = {
  beforeTashkeel: 'قبل التشكيل',
  tashkeelFull: 'تشكيل كامل',
  tashkeelSelection: 'تشكيل المحدد',
  tashkeelPartial: 'تشكيل جزئي',
  beforeProofread: 'قبل تطبيق التدقيق',
  autoPunct: 'تصحيح الترقيم تلقائياً',
  beforeGemini: 'قبل اقتراح Gemini',
  gemini: 'قبول اقتراح Gemini',
  beforeReplaceAll: 'قبل استبدال الكل',
  checkpoint: 'نقطة استرجاع'
} as const

export type SegKind = 'same' | 'gain' | 'lose'

export interface PreviewSeg {
  kind: SegKind
  text: string
}

/**
 * Backend ops are version -> current. For a preview of "what restoring does":
 * `gain` = only in the version (comes back), `lose` = only in the current text (goes away).
 * Long unchanged runs are shortened to `context` characters on each side around a «…».
 */
export function previewSegments(ops: DiffOp[], context = 80): PreviewSeg[] {
  const segs: PreviewSeg[] = []
  ops.forEach((o, i) => {
    if (!o.text) return
    if (o.op === 'delete') return void segs.push({ kind: 'gain', text: o.text })
    if (o.op === 'insert') return void segs.push({ kind: 'lose', text: o.text })
    const first = i === 0
    const last = i === ops.length - 1
    const keep = context * 2
    if (o.text.length <= keep + 20 || context <= 0)
      return void segs.push({ kind: 'same', text: o.text })
    const head = first ? '' : o.text.slice(0, context)
    const tail = last ? '' : o.text.slice(o.text.length - context)
    segs.push({ kind: 'same', text: `${head}${head || tail ? ' … ' : ''}${tail}` })
  })
  return segs
}

export function hasChanges(ops: DiffOp[]): boolean {
  return ops.some((o) => o.op !== 'equal' && o.text.length > 0)
}
