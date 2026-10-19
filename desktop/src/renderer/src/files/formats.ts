import { ApiError } from '@renderer/api/client'

export type ExportId = 'docx' | 'docx-track-edits' | 'docx-track' | 'txt' | 'md' | 'srt' | 'pdf'

export interface ExportFormat {
  id: ExportId
  label: string
  ext: string
  filterName: string
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: 'docx', label: 'Word (‎.docx‎)', ext: 'docx', filterName: 'Word' },
  {
    id: 'docx-track-edits',
    label: 'تصدير Word مع تعقّب التغييرات',
    ext: 'docx',
    filterName: 'Word'
  },
  { id: 'docx-track', label: 'تصدير بتتبع التغييرات', ext: 'docx', filterName: 'Word' },
  { id: 'txt', label: 'نص عادي (‎.txt‎)', ext: 'txt', filterName: 'Text' },
  { id: 'md', label: 'Markdown (‎.md‎)', ext: 'md', filterName: 'Markdown' },
  { id: 'srt', label: 'ترجمة SRT (‎.srt‎)', ext: 'srt', filterName: 'SubRip' },
  { id: 'pdf', label: 'PDF (‎.pdf‎)', ext: 'pdf', filterName: 'PDF' }
]

/** What «تصدير Word مع تعقّب التغييرات» records as Word revisions. */
export type TrackScope = 'both' | 'proofread' | 'diacritics'
export type TrackGranularity = 'word' | 'char'
export interface TrackedOptions {
  scope: TrackScope
  granularity: TrackGranularity
}
export const TRACK_SCOPES: [TrackScope, string][] = [
  ['both', 'التدقيق والتشكيل معاً'],
  ['proofread', 'التدقيق فقط'],
  ['diacritics', 'التشكيل فقط']
]
export const DEFAULT_TRACKED: TrackedOptions = { scope: 'both', granularity: 'word' }

export const IMPORT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'srt',
  'epub',
  'pdf',
  'docx',
  'png',
  'jpg',
  'jpeg',
  'tif',
  'tiff',
  'bmp',
  'webp'
]
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp'])
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'srt', 'epub'])

export type ImportKind = 'docx' | 'image' | 'pdf' | 'text' | 'unsupported'

export function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path)
  return m ? m[1].toLowerCase() : ''
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function stem(path: string): string {
  return baseName(path).replace(/\.[^.]+$/, '')
}

export function importKind(path: string): ImportKind {
  const e = extOf(path)
  if (e === 'docx') return 'docx'
  if (e === 'pdf') return 'pdf'
  if (IMAGE_EXT.has(e)) return 'image'
  if (TEXT_EXT.has(e)) return 'text'
  return 'unsupported'
}

/** Suggested file name for an export: the document title without characters Windows rejects. */
export function exportFileName(title: string | undefined, ext: string): string {
  const base = (title ?? '').replace(/[\\/:*?"<>|\0]/g, '_').trim() || 'mizaj'
  return `${base}.${ext}`
}

export interface OcrPage {
  page: number
  method: 'ocr' | 'text'
  text: string
  confidence: number | null
  words: number
}

/** Confidence band used to colour the per-page OCR badge. */
export function confidenceLevel(c: number | null): 'high' | 'medium' | 'low' | 'none' {
  if (c === null || Number.isNaN(c)) return 'none'
  if (c >= 85) return 'high'
  if (c >= 65) return 'medium'
  return 'low'
}

export const OCR_LEVEL_LABEL: Record<ReturnType<typeof confidenceLevel>, string> = {
  high: 'ثقة عالية',
  medium: 'ثقة متوسطة؛ راجع النص',
  low: 'ثقة منخفضة؛ راجع النص بعناية',
  none: 'نص مضمّن (بلا تعرّف ضوئي)'
}

/** Clear Arabic text for an OCR failure, with the install hint when Tesseract is missing. */
export function ocrErrorMessage(e: unknown): {
  text: string
  hint: string | null
  missing: boolean
} {
  if (e instanceof ApiError) {
    if (e.errorCode === 'ERR_OCR_TESSERACT_MISSING') {
      return {
        text: 'برنامج Tesseract غير مثبت على جهازك، ولا يمكن استيراد الملفات الممسوحة ضوئياً بدونه.',
        hint:
          typeof e.details.hint === 'string'
            ? e.details.hint
            : 'ثبّت Tesseract OCR مع بيانات اللغة العربية (ara).',
        missing: true
      }
    }
    if (e.errorCode === 'ERR_OCR_LANG_MISSING') {
      return {
        text: 'بيانات اللغة العربية لـ Tesseract غير مثبتة.',
        hint:
          typeof e.details.hint === 'string'
            ? e.details.hint
            : 'ثبّت حزمة اللغة العربية (ara) لبرنامج Tesseract.',
        missing: true
      }
    }
    return { text: e.messageAr, hint: null, missing: false }
  }
  return { text: 'تعذر التعرف الضوئي على الملف.', hint: null, missing: false }
}

/** Arabic text for the common error envelopes raised while writing an export. */
export function exportErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.errorCode === 'ERR_DOCX_WRITE_LOCKED')
      return 'الملف مفتوح في برنامج آخر (مثل Word)؛ أغلقه أو اختر مساراً آخر.'
    return e.messageAr
  }
  return 'تعذر التصدير.'
}
