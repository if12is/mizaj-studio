import { toArabicIndic } from './arabicDigits'

interface Unit {
  /** milliseconds in one unit */
  ms: number
  one: string
  two: string
  few: string // 3..10
  many: string // 11+
}

const UNITS: Unit[] = [
  { ms: 365 * 86_400_000, one: 'سنة', two: 'سنتين', few: 'سنوات', many: 'سنة' },
  { ms: 30 * 86_400_000, one: 'شهر', two: 'شهرين', few: 'أشهر', many: 'شهراً' },
  { ms: 7 * 86_400_000, one: 'أسبوع', two: 'أسبوعين', few: 'أسابيع', many: 'أسبوعاً' },
  { ms: 86_400_000, one: 'يوم', two: 'يومين', few: 'أيام', many: 'يوماً' },
  { ms: 3_600_000, one: 'ساعة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' },
  { ms: 60_000, one: 'دقيقة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة' }
]

/** «منذ ساعتين» / «منذ ٣ أيام» / «الآن»: Arabic plural forms, Arabic-Indic digits. */
export function relativeTimeAr(then: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - then)
  if (diff < 60_000) return 'الآن'
  for (const u of UNITS) {
    const n = Math.floor(diff / u.ms)
    if (n < 1) continue
    if (n === 1) return `منذ ${u.one}`
    if (n === 2) return `منذ ${u.two}`
    return `منذ ${toArabicIndic(n)} ${n <= 10 ? u.few : u.many}`
  }
  return 'الآن'
}
