import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { useApi } from '@renderer/api'
import { useEditorStore } from './editor'
import { useProjectsStore } from './projects'
import { isHidden, setHidden, toEditorOffsets, type CardField } from '@renderer/legal/caseCard'

export const DEBOUNCE_MS = 700

export const useCaseCardStore = defineStore('caseCard', () => {
  const fields = shallowRef<CardField[]>([])
  const collapsed = ref(false)
  const hidden = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  const docId = (): number | null => useProjectsStore().currentDocument?.id ?? null

  async function refresh(): Promise<void> {
    hidden.value = isHidden(docId())
    if (hidden.value) return
    const acc = useEditorStore().accessor
    if (!acc) return
    const text = acc.getText()
    const mine = ++seq
    if (!text.trim()) {
      fields.value = []
      return
    }
    try {
      const r = await useApi().request<{ fields: CardField[] }>(
        'POST',
        '/api/legal/case-card',
        { text },
        true
      )
      if (mine === seq) fields.value = toEditorOffsets(text, r.fields)
    } catch {
      /* background feature: stay quiet */
    }
  }

  /** Debounced refresh; call on every document change. */
  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, DEBOUNCE_MS)
  }

  function toggleHidden(): void {
    hidden.value = !hidden.value
    setHidden(docId(), hidden.value)
    if (!hidden.value) void refresh()
  }

  return { fields, collapsed, hidden, refresh, schedule, toggleHidden }
})
