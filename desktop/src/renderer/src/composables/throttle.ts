/**
 * Trailing throttle: fn runs at most once per `ms`, even if trigger() is called
 * continuously (a debounce would starve while a streaming run keeps editing).
 */
export function createThrottle(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    trigger(): void {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        fn()
      }, ms)
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
