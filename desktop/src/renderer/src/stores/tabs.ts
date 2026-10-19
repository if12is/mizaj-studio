import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Open document tabs. This store only holds the tab LIST (what is open, which is active, the
 * modified flag, recent documents); each tab's editor state (text, undo history, scroll,
 * selection, page view) lives in the editor layer and is keyed by the tab id (see App.vue).
 */
export interface Tab {
  id: string
  /** null = an empty "new tab" with no document yet */
  documentId: number | null
  projectId: number | null
  title: string
  /** unsaved changes (autosave has not stored them yet) */
  dirty: boolean
}

export interface RecentDoc {
  documentId: number
  projectId: number
  title: string
}

export const NEW_TAB_TITLE = 'تبويب جديد'
const STORAGE_KEY = 'mizaj.tabs.v1'
const RECENT_MAX = 12

interface Persisted {
  tabs: Pick<Tab, 'id' | 'documentId' | 'projectId' | 'title'>[]
  activeId: string | null
  recent: RecentDoc[]
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<Tab[]>([])
  const activeId = ref<string | null>(null)
  const recent = ref<RecentDoc[]>([])
  /** tab waiting for the "unsaved changes" answer */
  const closePrompt = ref<string | null>(null)
  let counter = 0

  const active = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null)
  const activeIndex = computed(() => tabs.value.findIndex((t) => t.id === activeId.value))

  function newId(): string {
    counter++
    return `t${Date.now().toString(36)}${counter}`
  }
  const byId = (id: string): Tab | undefined => tabs.value.find((t) => t.id === id)
  const byDocument = (documentId: number): Tab | undefined =>
    tabs.value.find((t) => t.documentId === documentId)

  /** Add a tab after the active one (or at the end); does not activate it. */
  function add(init: Partial<Tab> = {}, afterActive = true): Tab {
    const tab: Tab = {
      id: init.id ?? newId(),
      documentId: init.documentId ?? null,
      projectId: init.projectId ?? null,
      title: init.title ?? NEW_TAB_TITLE,
      dirty: false
    }
    const at = afterActive && activeIndex.value >= 0 ? activeIndex.value + 1 : tabs.value.length
    tabs.value = [...tabs.value.slice(0, at), tab, ...tabs.value.slice(at)]
    return tab
  }
  function setActive(id: string | null): void {
    if (id === null || byId(id)) activeId.value = id
    persist()
  }
  /** Remove a tab; returns the tab that should become active (null when the list is empty). */
  function remove(id: string): Tab | null {
    const i = tabs.value.findIndex((t) => t.id === id)
    if (i < 0) return active.value
    tabs.value = tabs.value.filter((t) => t.id !== id)
    if (closePrompt.value === id) closePrompt.value = null
    let next = active.value
    if (activeId.value === id) {
      next = tabs.value[Math.min(i, tabs.value.length - 1)] ?? null
      activeId.value = next?.id ?? null
    }
    persist()
    return next
  }
  /** Tab id `step` positions away from the active one, wrapping around. */
  function neighbour(step: 1 | -1): Tab | null {
    const n = tabs.value.length
    if (n === 0) return null
    const i = activeIndex.value < 0 ? 0 : (activeIndex.value + step + n) % n
    return tabs.value[i]
  }
  function move(from: number, to: number): void {
    const n = tabs.value.length
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return
    const next = [...tabs.value]
    const [t] = next.splice(from, 1)
    next.splice(to, 0, t)
    tabs.value = next
    persist()
  }
  function setDirty(id: string, dirty: boolean): void {
    const t = byId(id)
    if (t && t.dirty !== dirty) t.dirty = dirty
  }
  /** Point an (empty) tab at a document. */
  function assign(id: string, d: { documentId: number; projectId: number; title: string }): void {
    const t = byId(id)
    if (!t) return
    t.documentId = d.documentId
    t.projectId = d.projectId
    t.title = d.title
    persist()
  }
  function setTitle(documentId: number, title: string): void {
    let changed = false
    for (const t of tabs.value)
      if (t.documentId === documentId && t.title !== title) {
        t.title = title
        changed = true
      }
    recent.value = recent.value.map((r) => (r.documentId === documentId ? { ...r, title } : r))
    if (changed) persist()
  }
  function touchRecent(d: RecentDoc): void {
    recent.value = [d, ...recent.value.filter((r) => r.documentId !== d.documentId)].slice(
      0,
      RECENT_MAX
    )
    persist()
  }
  function forgetDocuments(ids: Set<number>): void {
    recent.value = recent.value.filter((r) => !ids.has(r.documentId))
    persist()
  }

  // ---------------------------------------------------------------- persistence
  function persist(): void {
    const s = storage()
    if (!s) return
    const data: Persisted = {
      tabs: tabs.value.map(({ id, documentId, projectId, title }) => ({
        id,
        documentId,
        projectId,
        title
      })),
      activeId: activeId.value,
      recent: recent.value
    }
    try {
      s.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      /* storage unavailable or full: tabs just are not restored */
    }
  }
  /** Read the saved tabs back (call once at startup). Tolerates missing/corrupt data. */
  function restore(): void {
    const s = storage()
    if (!s) return
    try {
      const raw = s.getItem(STORAGE_KEY)
      if (!raw) return
      const d = JSON.parse(raw) as Partial<Persisted>
      const list = (Array.isArray(d.tabs) ? d.tabs : []).filter(
        (t) =>
          t && typeof t.id === 'string' && (t.documentId === null || Number.isInteger(t.documentId))
      )
      tabs.value = list.map((t) => ({
        id: t.id,
        documentId: t.documentId ?? null,
        projectId: Number.isInteger(t.projectId) ? t.projectId : null,
        title: typeof t.title === 'string' ? t.title : NEW_TAB_TITLE,
        dirty: false
      }))
      activeId.value = tabs.value.some((t) => t.id === d.activeId)
        ? (d.activeId as string)
        : tabs.value[0]?.id ?? null
      recent.value = (Array.isArray(d.recent) ? d.recent : [])
        .filter((r) => r && Number.isInteger(r.documentId) && typeof r.title === 'string')
        .slice(0, RECENT_MAX)
    } catch {
      /* corrupt: start without tabs */
    }
  }
  /** Drop restored tabs whose document no longer exists. */
  function prune(exists: (documentId: number) => boolean): void {
    const keep = tabs.value.filter((t) => t.documentId === null || exists(t.documentId))
    if (keep.length === tabs.value.length) return
    tabs.value = keep
    if (!keep.some((t) => t.id === activeId.value)) activeId.value = keep[0]?.id ?? null
    recent.value = recent.value.filter((r) => exists(r.documentId))
    persist()
  }
  function reset(): void {
    tabs.value = []
    activeId.value = null
    recent.value = []
    closePrompt.value = null
  }

  return {
    tabs,
    activeId,
    active,
    activeIndex,
    recent,
    closePrompt,
    byId,
    byDocument,
    add,
    setActive,
    remove,
    neighbour,
    move,
    setDirty,
    assign,
    setTitle,
    touchRecent,
    forgetDocuments,
    persist,
    restore,
    prune,
    reset
  }
})
