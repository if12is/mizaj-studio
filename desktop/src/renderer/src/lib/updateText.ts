const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
export const arDigits = (n: number): string => String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)])

/** «خلال ٢ د» / «خلال ٣٠ ث» for a remaining time in ms. */
export function remainingText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (s >= 60) return `${arDigits(Math.ceil(s / 60))} د`
  return `${arDigits(s)} ث`
}

export interface RetryInfo {
  attempt?: number
  maxAttempts?: number
  nextRetryAt?: number | null
  offline?: boolean
}

/** Banner text for the updater's 'retrying' state (live countdown from `now`). */
export function retryText(s: RetryInfo, now: number): string {
  if (s.offline || s.nextRetryAt == null)
    return 'لا يوجد اتصال — سيُستأنف التحديث تلقائياً عند عودة الاتصال'
  const tries =
    s.attempt && s.maxAttempts
      ? ` (المحاولة ${arDigits(s.attempt)} من ${arDigits(s.maxAttempts)})`
      : ''
  return `انقطع الاتصال — ستُعاد المحاولة خلال ${remainingText(s.nextRetryAt - now)}${tries}`
}
