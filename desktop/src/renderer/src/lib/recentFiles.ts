import { shallowRef } from 'vue'

/**
 * «آخر الملفات» of the start screen + where the user stopped in each document (cursor, scroll).
 * Per device (localStorage); never leaves the machine. Kept tiny: it sits on the startup path.
 */
export interface RecentFile {
  documentId: number
  projectId: number
  title: string
  /** epoch ms of the last time the document was open */
  openedAt: number
  /** first words of the text, refreshed when the start screen shows */
  snippet: string
}
export interface ViewPos {
  /** cursor offset in the document */
  anchor: number
  scrollTop: number
}

const KEY = 'mizaj.recent.v1'
export const RECENT_MAX = 20
const VIEWS_MAX = 200

interface Persisted {
  files: RecentFile[]
  views: Record<string, ViewPos>
}

const store = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function read(): Persisted {
  try {
    const raw = store()?.getItem(KEY)
    if (!raw) return { files: [], views: {} }
    const d = JSON.parse(raw) as Partial<Persisted>
    const files = (Array.isArray(d.files) ? d.files : [])
      .filter(
        (f) =>
          !!f &&
          Number.isInteger(f.documentId) &&
          typeof f.title === 'string' &&
          typeof f.openedAt === 'number'
      )
      .map((f) => ({
        documentId: f.documentId,
        projectId: Number.isInteger(f.projectId) ? f.projectId : 0,
        title: f.title,
        openedAt: f.openedAt,
        snippet: typeof f.snippet === 'string' ? f.snippet : ''
      }))
    const views: Record<string, ViewPos> = {}
    for (const [k, v] of Object.entries(d.views && typeof d.views === 'object' ? d.views : {})) {
      const p = v as Partial<ViewPos>
      if (p && Number.isFinite(p.anchor) && Number.isFinite(p.scrollTop))
        views[k] = {
          anchor: Math.max(0, p.anchor as number),
          scrollTop: Math.max(0, p.scrollTop as number)
        }
    }
    return { files: files.slice(0, RECENT_MAX), views }
  } catch {
    return { files: [], views: {} }
  }
}

const state = read()
/** Reactive list, newest first. */
export const recentFiles = shallowRef<RecentFile[]>(state.files)

function persist(): void {
  try {
    store()?.setItem(KEY, JSON.stringify({ files: recentFiles.value, views: state.views }))
  } catch {
    /* storage unavailable or full: the list just is not remembered */
  }
}

/** A document was opened: it moves to the top of the list. */
export function touchRecentFile(
  d: Omit<RecentFile, 'openedAt' | 'snippet'>,
  now = Date.now()
): void {
  const old = recentFiles.value.find((f) => f.documentId === d.documentId)
  recentFiles.value = [
    { ...d, openedAt: now, snippet: old?.snippet ?? '' },
    ...recentFiles.value.filter((f) => f.documentId !== d.documentId)
  ].slice(0, RECENT_MAX)
  persist()
}
export function setRecentSnippet(documentId: number, snippet: string): void {
  if (!recentFiles.value.some((f) => f.documentId === documentId && f.snippet !== snippet)) return
  recentFiles.value = recentFiles.value.map((f) =>
    f.documentId === documentId ? { ...f, snippet } : f
  )
  persist()
}
export function renameRecentFile(documentId: number, title: string): void {
  if (!recentFiles.value.some((f) => f.documentId === documentId && f.title !== title)) return
  recentFiles.value = recentFiles.value.map((f) =>
    f.documentId === documentId ? { ...f, title } : f
  )
  persist()
}
/** Remove from the list (and forget where the user stopped). The document itself stays. */
export function removeRecentFile(documentId: number): void {
  recentFiles.value = recentFiles.value.filter((f) => f.documentId !== documentId)
  delete state.views[String(documentId)]
  persist()
}

export function saveViewPos(documentId: number, pos: ViewPos): void {
  const key = String(documentId)
  delete state.views[key] // re-insert: key order = recency, the oldest are dropped first
  state.views[key] = {
    anchor: Math.max(0, Math.round(pos.anchor)),
    scrollTop: Math.max(0, Math.round(pos.scrollTop))
  }
  const keys = Object.keys(state.views)
  for (const k of keys.slice(0, Math.max(0, keys.length - VIEWS_MAX))) delete state.views[k]
  persist()
}
export const getViewPos = (documentId: number): ViewPos | null =>
  state.views[String(documentId)] ?? null

/** Tests only: reload from storage. */
export function _reloadRecentForTests(): void {
  const s = read()
  state.views = s.views
  recentFiles.value = s.files
}
