import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const calls: { method: string; path: string; body?: unknown }[] = []
let responder: (method: string, path: string, body?: unknown) => unknown = () => ({})

vi.mock('@renderer/api', () => ({
  useApi: () => ({
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      return responder(method, path, body)
    },
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      return responder('GET', path)
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'POST', path, body })
      return responder('POST', path, body)
    }
  })
}))
vi.mock('@renderer/api/toast', () => ({ notify: vi.fn() }))

import { useEditorStore } from './editor'
import { useHistoryStore } from './history'
import { useProjectsStore } from './projects'

function setup(text: string) {
  const editor = useEditorStore()
  const projects = useProjectsStore()
  const state = { text }
  const applied: string[] = []
  editor.register({
    getText: () => state.text,
    setText: (t: string) => (state.text = t),
    applyEdit: (from: number, to: number, expected: string, insert: string) => {
      if (state.text.slice(from, to) !== expected) return false
      state.text = state.text.slice(0, from) + insert + state.text.slice(to)
      applied.push(insert)
      return true
    }
  } as never)
  projects.currentDocument = { id: 7, title: 't' } as never
  return { state, applied }
}

function today1430(): string {
  const d = new Date()
  d.setHours(14, 30, 0, 0)
  return d.toISOString()
}

const meta = (id: number, over = {}) => ({
  id,
  document_id: 7,
  created_at: today1430(),
  updated_at: '',
  kind: 'autosave',
  label: 'تعديل يدوي',
  name: '',
  char_count: 1,
  word_count: 1,
  words_added: 1,
  words_removed: 0,
  chars_delta: 1,
  ...over
})

beforeEach(() => {
  setActivePinia(createPinia())
  calls.length = 0
  responder = () => ({})
})

describe('history store', () => {
  it('record posts the editor text with the Arabic label, one request at a time and in order', async () => {
    const { state } = setup('قبل')
    const h = useHistoryStore()
    const order: string[] = []
    responder = (_m, _p, body) => {
      order.push((body as { label: string }).label)
      return {}
    }
    const a = h.record('قبل التشكيل')
    state.text = 'بعد' // the editor moves on while the first post is still queued
    const b = h.record('تشكيل كامل')
    await Promise.all([a, b])
    expect(order).toEqual(['قبل التشكيل', 'تشكيل كامل'])
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/documents/7/versions',
      body: { kind: 'event', label: 'قبل التشكيل', content: 'قبل' }
    })
    expect(calls[1].body).toMatchObject({ content: 'بعد' })
  })

  it('record never throws and does nothing without a saved document', async () => {
    setup('x')
    const h = useHistoryStore()
    responder = () => {
      throw new Error('offline')
    }
    await expect(h.record('تشكيل كامل')).resolves.toBe(false)
    useProjectsStore().currentDocument = null
    await expect(h.record('x')).resolves.toBe(false)
  })

  it('saveCheckpoint sends kind=checkpoint with the optional name', async () => {
    setup('نص')
    const h = useHistoryStore()
    await h.saveCheckpoint('مسودة أولى')
    expect(calls[0].body).toMatchObject({ kind: 'checkpoint', name: 'مسودة أولى' })
  })

  it('load flushes pending saves first and groups the result by day', async () => {
    setup('x')
    const h = useHistoryStore()
    const order: string[] = []
    h.registerFlush(async () => void order.push('flush'))
    responder = (_m, path) => {
      order.push(path)
      return { items: [meta(2), meta(1)], total: 2 }
    }
    await h.toggle(true)
    expect(order[0]).toBe('flush')
    expect(h.items.map((i) => i.id)).toEqual([2, 1])
    expect(h.groups).toHaveLength(1)
  })

  it('select fetches the diff against the current text', async () => {
    setup('x')
    const h = useHistoryStore()
    responder = (_m, path) =>
      path.includes('/diff')
        ? { ops: [{ op: 'insert', text: 'جديد' }], added: 0, removed: 1 }
        : { items: [meta(3)], total: 1 }
    await h.toggle(true)
    await h.select(3)
    expect(calls.at(-1)?.path).toBe('/api/documents/7/versions/diff?from=3&to=current')
    expect(h.diff?.ops[0].op).toBe('insert')
    expect(h.identical).toBe(false)
  })

  it('restore flushes, posts a local-time label, and replaces the text as one edit', async () => {
    const { state, applied } = setup('النص الحالي')
    const h = useHistoryStore()
    const order: string[] = []
    h.registerFlush(async () => void order.push('flush'))
    responder = (_m, path) => {
      if (path.endsWith('/restore')) {
        order.push('restore')
        return { version: meta(9, { kind: 'restore' }), content: 'النص القديم' }
      }
      if (path.includes('/diff')) return { ops: [], added: 0, removed: 0 }
      return { items: [meta(9, { kind: 'restore' }), meta(3)], total: 2 }
    }
    await h.toggle(true)
    order.length = 0
    const ok = await h.restore(3)
    expect(ok).toBe(true)
    expect(order.slice(0, 2)).toEqual(['flush', 'restore'])
    const post = calls.find((c) => c.path.endsWith('/restore'))
    expect((post?.body as { label: string }).label).toBe('استعادة نسخة ١٤:٣٠')
    expect(state.text).toBe('النص القديم')
    expect(applied).toEqual(['النص القديم'])
    expect(h.selectedId).toBe(9)
    expect(h.identical).toBe(true)
  })
})
