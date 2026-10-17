import { ApiError } from '@renderer/api/client'

export const BATCH_FORMATS = [
  ['docx', 'Word'],
  ['txt', 'نص'],
  ['md', 'Markdown'],
  ['srt', 'SRT'],
  ['epub', 'EPUB'],
  ['pdf', 'PDF (يُحفظ نصاً)']
] as const

export interface BatchError {
  path: string
  error_code?: string
  message_ar?: string
  message_en?: string
}

export interface BatchSnapshot {
  id: string
  status: 'queued' | 'running' | 'done' | 'cancelled' | 'failed'
  total: number
  done: number
  succeeded: number
  skipped: number
  current: string | null
  outputs: string[]
  errors: BatchError[]
}

export const BATCH_STATUS_LABEL: Record<BatchSnapshot['status'], string> = {
  queued: 'في الانتظار',
  running: 'جارٍ المعالجة…',
  done: 'اكتملت المعالجة',
  cancelled: 'أُلغيت المعالجة',
  failed: 'فشلت المعالجة'
}

export const isFinished = (s: BatchSnapshot['status']): boolean =>
  s === 'done' || s === 'cancelled' || s === 'failed'

export function batchPercent(s: Pick<BatchSnapshot, 'total' | 'done'>): number {
  if (!s.total) return 100
  return Math.min(100, Math.round((s.done / s.total) * 100))
}

/** One line per failed file: name + Arabic reason (falls back to the error code). */
export function describeBatchError(e: BatchError): string {
  const name = e.path.split(/[\\/]/).pop() ?? e.path
  return `${name}: ${e.message_ar || e.message_en || e.error_code || 'خطأ غير معروف'}`
}

export function batchStartError(e: unknown): string {
  if (e instanceof ApiError) return e.messageAr
  return 'تعذر بدء المعالجة.'
}

export interface BatchForm {
  input_dir: string
  output_dir: string
  mode: 'fast' | 'accurate'
  level: 'full' | 'irab_only' | 'minimal' | 'legal'
  formats: string[]
  recursive: boolean
  on_exist: 'skip' | 'rename' | 'overwrite'
  track_changes: boolean
}

export function validateBatchForm(f: BatchForm): string | null {
  if (!f.input_dir) return 'اختر مجلد الإدخال.'
  if (!f.output_dir) return 'اختر مجلد الإخراج.'
  if (f.input_dir === f.output_dir) return 'يجب أن يختلف مجلد الإخراج عن مجلد الإدخال.'
  if (!f.formats.length) return 'اختر صيغة واحدة على الأقل.'
  return null
}
