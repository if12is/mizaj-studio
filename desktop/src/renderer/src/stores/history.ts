import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { useEditorStore } from '@renderer/stores/editor'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  EVENT_LABELS,
  groupByDay,
  hasChanges,
  restoreLabel,
  type DiffOp,
  type VersionMeta
} from '@renderer/history/logic'

interface DiffResponse {
  ops: DiffOp[]
  added: number
  removed: number
}

/** Edit history («سجل التعديلات»): timeline, preview against the current text, restore. */
export const useHistoryStore = defineStore('history', () => {
  const open = ref(false)
  const items = ref<VersionMeta[]>([])
  const total = ref(0)
  const loading = ref(false)
  const selectedId = ref<number | null>(null)
  const diff = ref<DiffResponse | null>(null)
  const diffLoading = ref(false)
  const busy = ref(false)
  /** Saves the editor text now (autosave flush); registered by App.vue. */
  let flush: () => Promise<void> = () => Promise.resolve()
  let loadSeq = 0
  /** snapshots are posted one at a time so «قبل» always lands before «بعد» */
  let postChain: Promise<unknown> = Promise.resolve()
  let selectSeq = 0

  const docId = computed(() => useProjectsStore().currentDocument?.id ?? null)
  const groups = computed(() => groupByDay(items.value))
  const selected = computed(() => items.value.find((v) => v.id === selectedId.value) ?? null)
  const identical = computed(() => (diff.value ? !hasChanges(diff.value.ops) : false))

  function registerFlush(fn: (() => Promise<void>) | null): void {
    flush = fn ?? (() => Promise.resolve())
  }

  const base = (id: number): string => `/api/documents/${id}/versions`

  async function load(): Promise<void> {
    const id = docId.value
    const seq = ++loadSeq
    if (id === null) {
      items.value = []
      total.value = 0
      selectedId.value = null
      diff.value = null
      return
    }
    loading.value = true
    try {
      await flush() // the newest typing must be in the list
      const r = await useApi().get<{ items: VersionMeta[]; total: number }>(
        `${base(id)}?limit=500`,
        true
      )
      if (seq !== loadSeq || id !== docId.value) return
      items.value = r.items
      total.value = r.total
      if (selectedId.value !== null && !r.items.some((v) => v.id === selectedId.value)) {
        selectedId.value = null
        diff.value = null
      }
    } catch {
      /* offline / busy: keep what is shown */
    } finally {
      if (seq === loadSeq) loading.value = false
    }
  }

  async function toggle(force?: boolean): Promise<void> {
    open.value = force ?? !open.value
    if (open.value) await load()
  }

  async function select(vid: number | null): Promise<void> {
    const id = docId.value
    selectedId.value = vid
    diff.value = null
    if (vid === null || id === null) return
    const seq = ++selectSeq
    diffLoading.value = true
    try {
      await flush()
      const d = await useApi().get<DiffResponse>(`${base(id)}/diff?from=${vid}&to=current`, true)
      if (seq === selectSeq && selectedId.value === vid) diff.value = d
    } catch {
      /* shown as an empty preview */
    } finally {
      if (seq === selectSeq) diffLoading.value = false
    }
  }

  /** Put `text` into the editor as ONE undoable transaction (falls back to a reset). */
  function applyToEditor(text: string): void {
    const acc = useEditorStore().accessor
    if (!acc) return
    const cur = acc.getText()
    if (cur === text) return
    if (!acc.applyEdit(0, cur.length, cur, text)) acc.setText(text)
  }

  async function restore(vid: number): Promise<boolean> {
    const id = docId.value
    const v = items.value.find((x) => x.id === vid)
    if (id === null || !v || busy.value) return false
    busy.value = true
    try {
      await flush()
      const r = await useApi().post<{ version: VersionMeta; content: string }>(
        `${base(id)}/${vid}/restore`,
        { label: restoreLabel(v) }
      )
      if (id === docId.value) applyToEditor(r.content)
      useEditorStore().announce('تمت استعادة النسخة')
      await load()
      await select(r.version.id)
      return true
    } catch {
      return false
    } finally {
      busy.value = false
    }
  }

  async function saveCheckpoint(name: string): Promise<boolean> {
    if (!(await record(EVENT_LABELS.checkpoint, { kind: 'checkpoint', name }))) return false
    notify('تم حفظ نقطة الاسترجاع', { kind: 'success' })
    if (open.value) await load()
    return true
  }

  /**
   * Snapshot the editor text under an action label («قبل التشكيل», «تشكيل كامل», ...).
   * Never throws: history must not get in the way of editing. `content` overrides the
   * current editor text (used to capture the "before" text of an operation after the fact).
   */
  async function record(
    label: string,
    o: { kind?: 'event' | 'checkpoint'; name?: string; content?: string } = {}
  ): Promise<boolean> {
    const id = docId.value
    if (id === null || id <= 0) return false
    const content = o.content ?? useEditorStore().accessor?.getText()
    if (content === undefined) return false
    const body = { kind: o.kind ?? 'event', label, name: o.name ?? '', content }
    const post = postChain.then(async () => {
      try {
        await useApi().request('POST', base(id), body, true)
        return true
      } catch {
        return false
      }
    })
    postChain = post
    const ok = await post
    if (ok && open.value && id === docId.value) void load()
    return ok
  }

  return {
    open,
    items,
    total,
    loading,
    selectedId,
    selected,
    diff,
    diffLoading,
    busy,
    groups,
    identical,
    docId,
    registerFlush,
    load,
    toggle,
    select,
    restore,
    saveCheckpoint,
    record
  }
})

/** Fire-and-forget snapshot for the editing flows (tashkeel, proofreading, find/replace...). */
export function recordEvent(label: string, content?: string): void {
  void useHistoryStore().record(label, { content })
}
