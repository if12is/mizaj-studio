import { onBeforeUnmount, onMounted, type Ref } from 'vue'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Pure helper: index of the next focus target when Tab/Shift+Tab wraps inside a dialog. */
export function nextTrapIndex(current: number, count: number, shift: boolean): number {
  if (count === 0) return -1
  if (current < 0) return shift ? count - 1 : 0
  return shift ? (current - 1 + count) % count : (current + 1) % count
}

/** Keep keyboard focus inside a modal dialog, close on Escape, restore focus on close. */
export function useFocusTrap(el: Ref<HTMLElement | null>, onEscape: () => void): void {
  let previous: HTMLElement | null = null
  const items = (): HTMLElement[] =>
    el.value
      ? [...el.value.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (x) => x.offsetParent !== null
        )
      : []
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onEscape()
      return
    }
    if (e.key !== 'Tab') return
    const list = items()
    if (!list.length) return
    const idx = list.indexOf(document.activeElement as HTMLElement)
    const next = nextTrapIndex(idx, list.length, e.shiftKey)
    // only intervene at the boundaries; the browser handles the rest
    if ((e.shiftKey && idx <= 0) || (!e.shiftKey && idx === list.length - 1) || idx < 0) {
      e.preventDefault()
      list[next].focus()
    }
  }
  onMounted(() => {
    previous = document.activeElement as HTMLElement | null
    const list = items()
    ;(list[0] ?? el.value)?.focus()
    el.value?.addEventListener('keydown', onKey)
  })
  onBeforeUnmount(() => {
    el.value?.removeEventListener('keydown', onKey)
    previous?.focus?.()
  })
}
