import { ref } from 'vue'

export interface SpotlightState {
  rect: { top: number; left: number; width: number; height: number }
  text: string
}
export interface SpotlightRequest {
  selector: string
  text: string
  /** clicked first when the target is not in the DOM (e.g. to open a menu) */
  reveal?: string
  ms?: number
}

export const SPOTLIGHT_MS = 3000
const FIND_TIMEOUT_MS = 2000
const FIND_STEP_MS = 100

export const spotlight = ref<SpotlightState | null>(null)
let hideTimer: ReturnType<typeof setTimeout> | null = null
let cleanup: (() => void) | null = null
let runId = 0

const visible = (el: Element | null): el is HTMLElement => {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

export function hideSpotlight(): void {
  runId++
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  cleanup?.()
  cleanup = null
  spotlight.value = null
}

function place(el: HTMLElement, text: string): void {
  const r = el.getBoundingClientRect()
  spotlight.value = { rect: { top: r.top, left: r.left, width: r.width, height: r.height }, text }
}

/**
 * Waits for `selector` to be visible (clicking `reveal` once if needed), scrolls it into view and
 * shows a pulsing ring with a tooltip for `ms`. Resolves true when something was highlighted.
 */
export async function spotlightElement(req: SpotlightRequest): Promise<boolean> {
  hideSpotlight()
  const my = runId
  const deadline = Date.now() + FIND_TIMEOUT_MS
  let revealed = false
  let el: HTMLElement | null = null
  for (;;) {
    const found = document.querySelector(req.selector)
    if (visible(found)) {
      el = found
      break
    }
    if (!revealed && req.reveal) {
      document.querySelector<HTMLElement>(req.reveal)?.click()
      revealed = true
    }
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, FIND_STEP_MS))
    if (my !== runId) return false
  }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  place(el, req.text)
  const target = el
  const onMove = (): void => {
    if (my === runId && target.isConnected) place(target, req.text)
  }
  window.addEventListener('resize', onMove)
  window.addEventListener('scroll', onMove, true)
  cleanup = () => {
    window.removeEventListener('resize', onMove)
    window.removeEventListener('scroll', onMove, true)
  }
  hideTimer = setTimeout(() => hideSpotlight(), req.ms ?? SPOTLIGHT_MS)
  return true
}

export function useSpotlight(): {
  state: typeof spotlight
  show: typeof spotlightElement
  hide: typeof hideSpotlight
} {
  return { state: spotlight, show: spotlightElement, hide: hideSpotlight }
}
