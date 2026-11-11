import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
const native = { save: '/out/x.docx' as string | null, open: '/orig/a.docx' as string | null }

vi.mock('@renderer/api', () => ({
  useApi: () => ({
    request: async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body })
      if (path === '/api/docx/import') return { document_id: 7, conversion: 'text_only' }
      return { stats: { revisions: 3 } }
    }
  })
}))
vi.mock('@renderer/api/toast', () => ({ notify: vi.fn() }))
vi.mock('@renderer/lib/native', () => ({
  pickSavePath: async () => native.save,
  pickOpenPath: async () => native.open
}))

import { notify } from '@renderer/api/toast'
import { TEXT_ONLY_WARNING } from '@renderer/files/formats'
import { useEditorStore } from './editor'
import { useFileStore } from './fileio'
import { useProjectsStore } from './projects'

function setup(source: string | null, diffBase: string | null) {
  const files = useFileStore()
  const flush = vi.fn(async () => {
    calls.push({ method: 'FLUSH', path: '' })
  })
  files.registerHooks({ flush, openDocument: async () => {} })
  useProjectsStore().currentDocument = {
    id: 5,
    title: 'مذكرة',
    source_docx_path: source,
    raw_content: ''
  } as never
  useEditorStore().diffBase = diffBase
  return { files, flush }
}

describe('Word export routing', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    calls.length = 0
    native.save = '/out/x.docx'
    native.open = '/orig/a.docx'
    vi.mocked(notify).mockClear()
  })

  it('docx-track with a source file sends the same request as docx-track-edits defaults', async () => {
    const { files } = setup('/orig/a.docx', null)
    await files.exportAs('docx-track')
    expect(calls.map((c) => c.path)).toEqual(['', '/api/docx/export-tracked'])
    expect(calls[0].method).toBe('FLUSH') // unsaved text first
    expect(calls[1].body).toEqual({
      document_id: 5,
      target_path: '/out/x.docx',
      scope: 'both',
      granularity: 'word'
    })
  })

  it('docx-track without a source but with a diff base sends original_text', async () => {
    const { files } = setup(null, 'قبل')
    await files.exportAs('docx-track')
    expect(calls[1].path).toBe('/api/docx/export-tracked')
    expect(calls[1].body?.original_text).toBe('قبل')
  })

  it('docx-track with no origin at all keeps the legacy engine call on the picked file', async () => {
    const { files } = setup(null, null)
    await files.exportAs('docx-track')
    const last = calls[calls.length - 1]
    expect(last.path).toBe('/api/io/docx/track-changes')
    expect(last.body?.source_path).toBe('/orig/a.docx')
  })

  it('plain Word export is as_is and flushes first', async () => {
    const { files, flush } = setup('/orig/a.docx', null)
    await files.exportAs('docx')
    expect(flush).toHaveBeenCalledTimes(1)
    expect(calls[1].path).toBe('/api/docx/export')
    expect(calls[1].body?.as_is).toBe(true)
  })

  it('warns when a legacy file was imported as text only', async () => {
    setup(null, null)
    const projects = useProjectsStore()
    projects.currentProjectId = 1
    projects.loadDocuments = (async () => {}) as never
    await useFileStore().importFile('/x/old.doc')
    expect(notify).toHaveBeenCalledWith(
      TEXT_ONLY_WARNING,
      expect.objectContaining({ kind: 'warning' })
    )
  })
})
