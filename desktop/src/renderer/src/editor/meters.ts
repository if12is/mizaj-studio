/** Feet (taf'ilat) of ONE hemistich per meter. Mirrors backend/app/arud/meters.py::METERS. */
export const METER_FEET: Record<string, string[]> = {
  الطويل: ['فعولن', 'مفاعيلن', 'فعولن', 'مفاعيلن'],
  المديد: ['فاعلاتن', 'فاعلن', 'فاعلاتن'],
  البسيط: ['مستفعلن', 'فاعلن', 'مستفعلن', 'فاعلن'],
  الوافر: ['مفاعلتن', 'مفاعلتن', 'فعولن'],
  الكامل: ['متفاعلن', 'متفاعلن', 'متفاعلن'],
  الهزج: ['مفاعيلن', 'مفاعيلن'],
  الرجز: ['مستفعلن', 'مستفعلن', 'مستفعلن'],
  الرمل: ['فاعلاتن', 'فاعلاتن', 'فاعلاتن'],
  السريع: ['مستفعلن', 'مستفعلن', 'فاعلن'],
  المنسرح: ['مستفعلن', 'مفعولات', 'مستفعلن'],
  الخفيف: ['فاعلاتن', 'مستفعلن', 'فاعلاتن'],
  المضارع: ['مفاعيلن', 'فاعلاتن'],
  المقتضب: ['مفعولات', 'مستفعلن'],
  المجتث: ['مستفعلن', 'فاعلاتن'],
  المتقارب: ['فعولن', 'فعولن', 'فعولن', 'فعولن'],
  المتدارك: ['فاعلن', 'فاعلن', 'فاعلن', 'فاعلن']
}

export interface ArudHemistich {
  text: string
  meters: string[]
  missing_marks: number[]
  closest?: { meter: string; matched_letters: number }
}

export interface ArudResult {
  meter: string | null
  matched_hemistichs: number
  hemistichs: number
  candidates: { meter: string; hemistichs: number }[]
  verses: { hemistichs: ArudHemistich[] }[]
  limits?: string
  diacritized: boolean
  text: string
}

/** One-line human summary of a hemistich result (honest about failures). */
export function describeHemistich(h: ArudHemistich): string {
  if (h.meters.length) return `البحر: ${h.meters.join(' / ')}`
  if (h.missing_marks.length) return `تعذر التحليل: ${h.missing_marks.length} حرف بلا تشكيل`
  if (h.closest)
    return `لا بحر مطابق؛ الأقرب ${h.closest.meter} حتى الحرف ${h.closest.matched_letters}`
  return 'لا بحر مطابق'
}
