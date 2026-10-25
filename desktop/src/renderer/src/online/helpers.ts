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
  installed: { path: string; sha256: string; source: string; enabled?: boolean } | null
  /** installed AND switched on (the backend auto-enables local, private resources) */
  enabled?: boolean
  /** bytes on disk (installed items) / bytes to download (others, null when unknown) */
  installed_size?: number | null
  download_size?: number | null
  /** the catalog pins a different hash than the installed one */
  update_available?: boolean
  job: ResourceJob | null
}

export interface ResourceJob {
  id: string
  status: 'queued' | 'running' | 'paused' | 'done' | 'cancelled' | 'failed'
  /** "installing" while an archive is being unpacked after the download */
  phase?: 'downloading' | 'installing'
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

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
export const arDigits = (n: number): string => String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)])

export type ResourceState =
  | 'missing'
  | 'downloading'
  | 'installing'
  | 'enabled'
  | 'disabled'
  | 'error'

export interface ResourceStateInfo {
  state: ResourceState
  /** chip text (one label per state) */
  label: string
  icon: string
  /** Tailwind background class of the chip */
  bg: string
  /** tooltip: what this state means and what to do */
  tip: string
}

type StateInput = Pick<Resource, 'installed' | 'job'> & { enabled?: boolean }

/** The one place that turns the backend listing item into a state, label, colour and tooltip. */
export function resourceState(r: StateInput): ResourceStateInfo {
  const j = r.job
  if (jobActive(j)) {
    if (j!.phase === 'installing')
      return {
        state: 'installing',
        label: 'جارٍ التثبيت…',
        icon: '⚙',
        bg: 'bg-sky-700',
        tip: 'اكتمل التنزيل وجارٍ فك الضغط والتحقق من الملفات. لا تُغلق التطبيق.'
      }
    const pct = jobPercent(j)
    return {
      state: 'downloading',
      label: pct === null ? 'جارٍ التنزيل…' : `جارٍ التنزيل… ${arDigits(pct)}٪`,
      icon: '⬇',
      bg: 'bg-sky-700',
      tip: 'يجري تنزيل الملف والتحقق من سلامته (SHA-256). يمكنك إلغاء التنزيل في أي وقت.'
    }
  }
  if (r.installed) {
    if (r.enabled === false)
      return {
        state: 'disabled',
        label: 'مثبّت — غير مفعّل',
        icon: '⏸',
        bg: 'bg-amber-700',
        tip: 'الملفات موجودة على جهازك لكن المورد متوقف ولا يستخدمه التطبيق. اضغط «تفعيل» ليبدأ العمل.'
      }
    return {
      state: 'enabled',
      label: 'مثبّت ومفعّل ✓',
      icon: '✓',
      bg: 'bg-emerald-700',
      tip: 'مثبّت على جهازك ويعمل الآن. لا حاجة لتنزيله مرة أخرى.'
    }
  }
  if (j && (j.status === 'failed' || j.status === 'paused')) {
    const msg = j.error?.message_ar ?? (j.status === 'paused' ? 'انقطع التنزيل' : 'فشل التنزيل')
    return {
      state: 'error',
      label: `خطأ: ${msg}`,
      icon: '⚠',
      bg: 'bg-red-700',
      tip: 'لم يكتمل التنزيل أو التثبيت. اضغط «إعادة المحاولة» (يُكمل التنزيل من حيث توقف).'
    }
  }
  return {
    state: 'missing',
    label: 'غير مثبّت',
    icon: '○',
    bg: 'bg-slate-600',
    tip: 'غير موجود على جهازك. نزّله من الأسفل بعد قبول الترخيص.'
  }
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
