import { ref } from 'vue'

const reduced = ref(false)
let wired = false

/** Reactive `prefers-reduced-motion: reduce` (shared singleton, listener attached once). */
export function useReducedMotion() {
  if (!wired) {
    wired = true
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      reduced.value = mq.matches
      mq.addEventListener('change', (e) => (reduced.value = e.matches))
    } catch {
      /* no matchMedia (unit tests): motion stays enabled */
    }
  }
  return reduced
}
