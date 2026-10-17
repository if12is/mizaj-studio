import { ref } from 'vue'

export interface Toast {
  id: number
  text: string
}
export const toasts = ref<Toast[]>([])
let seq = 0

export function notify(text: string, ms = 5000): void {
  const id = ++seq
  toasts.value.push({ id, text })
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, ms)
}
