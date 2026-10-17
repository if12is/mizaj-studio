/** Run `fn` when the main thread is idle (falls back to a short timeout). Returns a canceller. */
export function whenIdle(fn: () => void, timeout = 1500): () => void {
  if (typeof window === 'undefined') {
    const t = setTimeout(fn, 0)
    return () => clearTimeout(t)
  }
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    cancelIdleCallback?: (h: number) => void
  }
  if (w.requestIdleCallback) {
    const h = w.requestIdleCallback(fn, { timeout })
    return () => w.cancelIdleCallback?.(h)
  }
  const t = setTimeout(fn, 50)
  return () => clearTimeout(t)
}

/** True when the user asked the OS for reduced motion (non-essential motion must be skipped). */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
