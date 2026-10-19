import { ApiError } from '@renderer/api/client'

export const ONLINE_KEYS = ['online_resources', 'online_languagetool'] as const
export type OnlineKey = (typeof ONLINE_KEYS)[number]

export const ONLINE_LABEL: Record<OnlineKey, { title: string; help: string }> = {
  online_resources: {
    title: 'تنزيل الموارد المجانية العامة',
    help: 'يسمح بتنزيل ملفات عامة مجانية (قواميس، نص القرآن من Tanzil، نماذج) من مضيفين محددين فقط، مع التحقق من الاختزال والترخيص.'
  },
  online_languagetool: {
    title: 'LanguageTool المحلي',
    help: 'يتصل بخادم LanguageTool الذي ثبّتّه أنت على جهازك (127.0.0.1) لتدقيق إضافي.'
  }
}

export interface OnlineStatus {
  switches: Record<OnlineKey, boolean>
  allowed_hosts: string[]
  leaves_device: Record<OnlineKey, string>
  recent_requests: { kind: string; url: string; outcome: string }[]
}

/** Arabic rendering of the backend's "what leaves your device" sentence. */
export const LEAVES_AR: Record<OnlineKey, string> = {
  online_resources:
    'يغادر جهازك طلب تنزيل الملف العام المختار فقط (العنوان وعنوان الـIP)؛ لا يُرسل أي نص من مستنداتك ولا بيانات شخصية.',
  online_languagetool: 'لا يغادر جهازك شيء (اتصال محلي عبر 127.0.0.1 فقط).'
}

export interface Resource {
  id: string
  name: string
  kind: string
  url: string
  filename: string
  sha256: string | null
  size: number | null
  license: string
  license_url: string
  attribution: string
  notes: string
  notice_ar?: string
  requires?: string[]
  requires_user_file: boolean
  installed: { path: string; sha256: string; source: string } | null
  job: ResourceJob | null
}

export interface ResourceJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'cancelled' | 'failed'
  bytes_done: number
  bytes_total: number | null
  error?: { message_ar?: string; error_code?: string }
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'غير معروف'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function jobPercent(
  j: Pick<ResourceJob, 'bytes_done' | 'bytes_total'> | null
): number | null {
  if (!j || !j.bytes_total) return null
  return Math.min(100, Math.round((j.bytes_done / j.bytes_total) * 100))
}

export const jobActive = (j: ResourceJob | null): boolean =>
  !!j && (j.status === 'queued' || j.status === 'running')

export const RESOURCE_KIND_LABEL: Record<string, string> = {
  'quran-text': 'نص القرآن',
  'spell-dictionary': 'قاموس إملاء',
  corpus: 'مدونة',
  models: 'نماذج',
  'tts-engine': 'محرك نطق',
  'tts-voice': 'صوت نطق'
}

export interface ToolsStatus {
  languagetool: { detected: boolean; url: string; arabic: boolean }
  tesseract: {
    detected: boolean
    path: string | null
    languages: string[]
    arabic?: boolean
    hint: string | null
  }
}

export const TOOL_INFO = {
  languagetool: {
    title: 'LanguageTool',
    install: 'نزّل LanguageTool (نسخة الخادم)، وشغّل الخادم المحلي على المنفذ 8081.',
    url: 'https://languagetool.org/download/'
  },
  tesseract: {
    title: 'Tesseract OCR',
    install: 'ثبّت Tesseract مع بيانات اللغة العربية (ara) لاستيراد الملفات الممسوحة.',
    url: 'https://github.com/UB-Mannheim/tesseract/wiki'
  }
} as const

export function onlineErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.errorCode === 'ERR_ONLINE_DISABLED')
      return 'هذه الميزة معطّلة؛ فعّل «تنزيل الموارد المجانية» أولاً.'
    if (e.errorCode === 'ERR_LICENSE_NOT_ACCEPTED') return 'يجب قبول الترخيص قبل المتابعة.'
    return e.messageAr
  }
  return 'تعذرت العملية.'
}

/** Quran settings: always an Arabic, actionable message (never a raw/English error). */
export function quranErrText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.errorCode === 'ERR_ONLINE_DISABLED')
      return 'التنزيل معطّل؛ فعّل «تنزيل الموارد المجانية العامة» من تبويب الاتصال.'
    if (e.errorCode === 'ERR_UNKNOWN')
      return 'تعذر الاتصال بالمحرك الخلفي. أعد تشغيل التطبيق ثم حاول مجدداً.'
    return e.messageAr || 'تعذرت العملية.'
  }
  return 'تعذر الاتصال بالمحرك الخلفي. تحقق من حالة المحرك في أسفل النافذة ثم حاول مجدداً.'
}
