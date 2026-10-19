import { ref } from 'vue'

export interface ToastAction {
  label: string
  primary?: boolean
  testid?: string
  run: () => void | Promise<void>
  /** keep the toast open after the handler ran (default: dismissed) */
  keep?: boolean
}
export interface ActionToast {
  id: number
  title?: string
  text: string
  actions: ToastAction[]
  kind: 'success' | 'info'
  testid?: string
}
export interface ActionToastOptions {
  title?: string
  text: string
  actions?: ToastAction[]
  kind?: 'success' | 'info'
  /** auto-dismiss after this many ms; 0 = stays until dismissed (default 12 s) */
  ms?: number
  testid?: string
  onDismiss?: () => void
}

export const actionToasts = ref<ActionToast[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const dismissHooks = new Map<number, () => void>()
let seq = 0

export function dismissActionToast(id: number): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  if (!actionToasts.value.some((x) => x.id === id)) return
  actionToasts.value = actionToasts.value.filter((x) => x.id !== id)
  const h = dismissHooks.get(id)
  dismissHooks.delete(id)
  h?.()
}

/** Non-blocking toast with buttons. Returns its id. Reusable by any feature. */
export function showActionToast(o: ActionToastOptions): number {
  const id = ++seq
  actionToasts.value = [
    ...actionToasts.value,
    {
      id,
      title: o.title,
      text: o.text,
      actions: o.actions ?? [],
      kind: o.kind ?? 'info',
      testid: o.testid
    }
  ]
  if (o.onDismiss) dismissHooks.set(id, o.onDismiss)
  const ms = o.ms ?? 12_000
  if (ms > 0)
    timers.set(
      id,
      setTimeout(() => dismissActionToast(id), ms)
    )
  return id
}

export async function runToastAction(t: ActionToast, a: ToastAction): Promise<void> {
  try {
    await a.run()
  } finally {
    if (!a.keep) dismissActionToast(t.id)
  }
}

export function useActionToast(): {
  toasts: typeof actionToasts
  show: typeof showActionToast
  dismiss: typeof dismissActionToast
} {
  return { toasts: actionToasts, show: showActionToast, dismiss: dismissActionToast }
}
