export type GeminiErrorCode =
  | 'disabled'
  | 'consent'
  | 'no_key'
  | 'invalid_key'
  | 'quota'
  | 'offline'
  | 'timeout'
  | 'safety'
  | 'recitation'
  | 'blocked_other'
  | 'empty'
  | 'bad_request'
  | 'bad_response'
  | 'unavailable'

const MESSAGES: Record<GeminiErrorCode, string> = {
  disabled: 'مساعد Gemini معطّل. فعّله من الإعدادات أولاً.',
  consent: 'لم تُوافق بعد على إشعار إرسال النص إلى Google.',
  no_key: 'لم تُدخل مفتاح API بعد. أضِفه من الإعدادات.',
  invalid_key: 'مفتاح API غير صالح أو لا يملك الصلاحية. تحقق منه في Google AI Studio.',
  quota: 'تجاوزتَ حدّ الاستخدام (الحصة) لدى Google. انتظر قليلاً ثم أعد المحاولة.',
  offline: 'تعذر الاتصال بـ Google. تحقق من اتصالك بالإنترنت.',
  timeout: 'انتهت مهلة الانتظار قبل وصول الرد. أعد المحاولة.',
  safety: 'حجب Gemini هذا الطلب لأسباب تتعلق بالسلامة، فلا يوجد رد.',
  recitation: 'أوقف Gemini الرد لأنه يطابق نصاً محمياً (استشهاد حرفي). أعد صياغة السؤال.',
  blocked_other: 'أوقف Gemini الرد لسبب غير محدد. أعد المحاولة أو جرّب نموذجاً آخر.',
  empty: 'لم يُنتج النموذج نصاً (استنفد حدّ الإخراج في التفكير). أعد المحاولة أو اختر نموذجاً أخف.',
  bad_request: 'رفض Gemini الطلب (قد يكون النموذج المحدد غير مدعوم). جرّب نموذجاً آخر.',
  bad_response: 'ردّ Gemini بصيغة غير متوقعة.',
  unavailable:
    'تعذر حفظ المفتاح بأمان: التشفير غير متاح على هذا الجهاز، لذلك لن يُحفظ المفتاح نصّاً صريحاً.'
}

export class GeminiError extends Error {
  constructor(
    readonly code: GeminiErrorCode,
    message?: string,
    /** seconds Google asked us to wait (quota), when known */
    readonly retryAfterSec?: number,
    /** HTTP status of the failed call, when there was one (used by the cache logic) */
    readonly status?: number
  ) {
    super(message ?? MESSAGES[code])
    this.name = 'GeminiError'
  }
}

export function quotaMessage(sec?: number): string {
  if (!sec) return MESSAGES.quota
  return `تجاوزتَ حدّ الاستخدام (الحصة) لدى Google. المدة المطلوبة للانتظار نحو ${Math.ceil(sec)} ثانية. يمكنك اختيار نموذج أخف (مثل flash-lite) من الإعدادات.`
}

export function messageFor(code: GeminiErrorCode): string {
  return MESSAGES[code]
}
