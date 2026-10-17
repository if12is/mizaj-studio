import { ref } from 'vue'

export type ToastKind = 'error' | 'success' | 'info'

export interface Toast {
  id: number
  text: string
  kind: ToastKind
}
export const toasts = ref<Toast[]>([])
let seq = 0

export function notify(text: string, opts: { kind?: ToastKind; ms?: number } = {}): void {
  const id = ++seq
  toasts.value.push({ id, text, kind: opts.kind ?? 'error' })
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, opts.ms ?? 5000)
}

export const toastClass: Record<ToastKind, string> = {
  error: 'bg-red-600',
  success: 'bg-mizaj-emerald',
  info: 'bg-slate-600'
}
