import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTabsStore } from './tabs'

class MemStorage {
  data = new Map<string, string>()
  getItem = (k: string): string | null => this.data.get(k) ?? null
  setItem = (k: string, v: string): void => void this.data.set(k, v)
  removeItem = (k: string): void => void this.data.delete(k)
}
let mem: MemStorage

beforeEach(() => {
  mem = new MemStorage()
  vi.stubGlobal('localStorage', mem)
  setActivePinia(createPinia())
})

function open(
  store: ReturnType<typeof useTabsStore>,
  documentId: number,
  title = `d${documentId}`
) {
  const t = store.add({ documentId, projectId: 1, title })
  store.setActive(t.id)
  return t
}

describe('tabs store', () => {
  it('adds tabs after the active one and activates', () => {
    const s = useTabsStore()
    const a = open(s, 1)
    const b = open(s, 2)
    s.setActive(a.id)
    const c = s.add({ documentId: 3 })
    expect(s.tabs.map((t) => t.id)).toEqual([a.id, c.id, b.id])
    expect(s.byDocument(2)?.id).toBe(b.id)
  })

  it('neighbour wraps around in both directions', () => {
    const s = useTabsStore()
    const a = open(s, 1)
    const b = open(s, 2)
    const c = open(s, 3)
    expect(s.activeId).toBe(c.id)
    expect(s.neighbour(1)?.id).toBe(a.id)
    s.setActive(a.id)
    expect(s.neighbour(-1)?.id).toBe(c.id)
    expect(s.neighbour(1)?.id).toBe(b.id)
  })

  it('closing the active tab activates the tab that took its place (or the previous)', () => {
    const s = useTabsStore()
    const a = open(s, 1)
    const b = open(s, 2)
    const c = open(s, 3)
    s.setActive(b.id)
    expect(s.remove(b.id)?.id).toBe(c.id)
    expect(s.activeId).toBe(c.id)
    expect(s.remove(c.id)?.id).toBe(a.id)
    expect(s.remove(a.id)).toBeNull()
    expect(s.activeId).toBeNull()
  })

  it('closing a background tab keeps the active one', () => {
    const s = useTabsStore()
    const a = open(s, 1)
    const b = open(s, 2)
    expect(s.remove(a.id)?.id).toBe(b.id)
    expect(s.activeId).toBe(b.id)
  })

  it('reorders tabs and ignores bad indexes', () => {
    const s = useTabsStore()
    const a = open(s, 1)
    const b = open(s, 2)
    const c = open(s, 3)
    s.move(0, 2)
    expect(s.tabs.map((t) => t.id)).toEqual([b.id, c.id, a.id])
    s.move(5, 0)
    s.move(1, 1)
    expect(s.tabs.map((t) => t.id)).toEqual([b.id, c.id, a.id])
  })

  it('tracks the modified flag and titles', () => {
    const s = useTabsStore()
    const a = open(s, 1, 'قديم')
    s.setDirty(a.id, true)
    expect(s.byId(a.id)?.dirty).toBe(true)
    s.setTitle(1, 'جديد')
    expect(s.byId(a.id)?.title).toBe('جديد')
  })

  it('keeps a most-recent-first recent list without duplicates, capped', () => {
    const s = useTabsStore()
    for (let i = 1; i <= 20; i++) s.touchRecent({ documentId: i, projectId: 1, title: `d${i}` })
    s.touchRecent({ documentId: 5, projectId: 1, title: 'd5' })
    expect(s.recent[0].documentId).toBe(5)
    expect(s.recent.filter((r) => r.documentId === 5)).toHaveLength(1)
    expect(s.recent.length).toBeLessThanOrEqual(12)
    s.forgetDocuments(new Set([5]))
    expect(s.recent.some((r) => r.documentId === 5)).toBe(false)
  })

  it('persists and restores tabs, the active tab and recent files (without the dirty flag)', () => {
    const s = useTabsStore()
    const a = open(s, 1, 'أ')
    const b = open(s, 2, 'ب')
    s.setDirty(b.id, true)
    s.touchRecent({ documentId: 1, projectId: 1, title: 'أ' })
    s.setActive(a.id)
    s.move(0, 1)

    setActivePinia(createPinia())
    const r = useTabsStore()
    r.restore()
    expect(r.tabs.map((t) => t.documentId)).toEqual([2, 1])
    expect(r.activeId).toBe(a.id)
    expect(r.tabs.every((t) => !t.dirty)).toBe(true)
    expect(r.recent[0].documentId).toBe(1)
  })

  it('restore tolerates corrupt or missing storage', () => {
    mem.setItem('mizaj.tabs.v1', '{not json')
    const s = useTabsStore()
    s.restore()
    expect(s.tabs).toEqual([])
    mem.setItem(
      'mizaj.tabs.v1',
      JSON.stringify({ tabs: [{ id: 5 }, { id: 'ok', documentId: null }], activeId: 'zzz' })
    )
    s.restore()
    expect(s.tabs.map((t) => t.id)).toEqual(['ok'])
    expect(s.activeId).toBe('ok')
  })

  it('prune drops tabs of documents that no longer exist and fixes the active tab', () => {
    const s = useTabsStore()
    open(s, 1)
    const b = open(s, 2)
    const blank = s.add({})
    s.setActive(b.id)
    s.prune((id) => id === 1)
    expect(s.tabs.map((t) => t.documentId)).toEqual([1, null])
    expect(s.tabs.some((t) => t.id === blank.id)).toBe(true)
    expect(s.activeId).toBe(s.tabs[0].id)
  })

  it('works without any storage available', () => {
    vi.stubGlobal('localStorage', undefined)
    const s = useTabsStore()
    expect(() => open(s, 1)).not.toThrow()
    expect(() => s.restore()).not.toThrow()
  })
})
