import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { ApiError } from '@renderer/api/client'
import {
  EXPORT_FORMATS,
  IMPORT_EXTENSIONS,
  baseName,
  exportErrorMessage,
  exportFileName,
  importKind,
  ocrErrorMessage,
  stem,
  type ExportId,
  type OcrPage
} from '@renderer/files/formats'
import { pickOpenPath, pickSavePath } from '@renderer/lib/native'
import { useEditorStore } from './editor'
import { useProjectsStore } from './projects'
import { useSettingsStore } from './settings'

export interface Hooks {
  flush: () => Promise<void>
  openDocument: (id: number) => Promise<void>
}

/** Text waiting for the user's review before it becomes a document (PDF / OCR imports). */
export interface ImportPreview {
  title: string
  path: string
  text: string
  source: 'pdf' | 'ocr'
  pages: OcrPage[]
  confidence: number | null
  hint: string | null
}

export interface OcrFailure {
  path: string
  text: string
  hint: string | null
  missing: boolean
}

export const useFileStore = defineStore('fileio', () => {
  let hooks: Hooks | null = null
  const busy = ref(false)
  const preview = ref<ImportPreview | null>(null)
  const ocrFailure = ref<OcrFailure | null>(null)
  const batchOpen = ref(false)

  function registerHooks(h: Hooks | null): void {
    hooks = h
  }

  async function ensureProjectId(): Promise<number> {
    const projects = useProjectsStore()
    let pid = projects.currentProjectId ?? projects.projects[0]?.id
    if (pid === undefined) pid = (await projects.createProject('مستندات مستوردة')).id
    return pid
  }

  async function createFromText(title: string, text: string): Promise<void> {
    const pid = await ensureProjectId()
    const d = await useProjectsStore().createDocument(pid, title, text, 'استيراد')
    await hooks?.openDocument(d.id)
    notify('تم إنشاء المستند من الملف المستورد.', { kind: 'success' })
  }

  // ------------------------------------------------------------ export
  async function exportAs(id: ExportId): Promise<void> {
    const fmt = EXPORT_FORMATS.find((f) => f.id === id)
    const projects = useProjectsStore()
    const settings = useSettingsStore()
    const doc = projects.currentDocument
    if (!fmt || !doc) return void notify('افتح مستنداً أولاً.', { kind: 'info' })
    busy.value = true
    try {
      let source: string | null = null
      if (id === 'docx-track') {
        // tracked changes need the original Word file to compare against
        source = doc.source_docx_path
        if (!source) {
          notify('اختر ملف Word الأصلي ليُقارَن به التشكيل وتُسجَّل التغييرات.', { kind: 'info' })
          source = await pickOpenPath(['docx'], 'Word')
          if (!source) return
        }
      }
      const target = await pickSavePath(
        exportFileName(doc.title, fmt.ext),
        [fmt.ext],
        fmt.filterName
      )
      if (!target) return
      await hooks?.flush()
      const api = useApi()
      if (id === 'docx') {
        await api.request(
          'POST',
          '/api/docx/export',
          {
            document_id: doc.id,
            target_path: target,
            mode: settings.values.engine_mode,
            level: settings.values.tashkeel_level
          },
          true
        )
      } else if (id === 'docx-track') {
        await api.request(
          'POST',
          '/api/io/docx/track-changes',
          {
            source_path: source,
            target_path: target,
            mode: settings.values.engine_mode,
            level: settings.values.tashkeel_level
          },
          true
        )
      } else {
        const text = useEditorStore().accessor?.getText() ?? doc.raw_content
        await api.request(
          'POST',
          '/api/io/export',
          { target_path: target, text, title: doc.title },
          true
        )
      }
      notify(`تم التصدير: ${target}`, { kind: 'success', ms: 7000 })
    } catch (e) {
      notify(exportErrorMessage(e))
    } finally {
      busy.value = false
    }
  }

  // ------------------------------------------------------------ import
  async function runOcr(path: string, forceOcr = false): Promise<boolean> {
    try {
      const r = await useApi().request<{
        pages: OcrPage[]
        text: string
        confidence: number | null
      }>('POST', '/api/ocr', { path, force_ocr: forceOcr }, true)
      ocrFailure.value = null
      preview.value = {
        title: stem(path),
        path,
        text: r.text,
        source: 'ocr',
        pages: r.pages,
        confidence: r.confidence,
        hint: null
      }
      return true
    } catch (e) {
      const m = ocrErrorMessage(e)
      ocrFailure.value = { path, text: m.text, hint: m.hint, missing: m.missing }
      return false
    }
  }

  async function importFile(pathArg?: string): Promise<void> {
    const path = pathArg ?? (await pickOpenPath(IMPORT_EXTENSIONS, 'Documents'))
    if (!path) return
    const kind = importKind(path)
    if (kind === 'unsupported') return void notify('صيغة الملف غير مدعومة للاستيراد.')
    busy.value = true
    try {
      const api = useApi()
      if (kind === 'docx') {
        const pid = await ensureProjectId()
        const r = await api.request<{ document_id: number }>(
          'POST',
          '/api/docx/import',
          { path, project_id: pid },
          true
        )
        await useProjectsStore().loadDocuments(pid)
        await hooks?.openDocument(r.document_id)
        notify('تم استيراد ملف Word.', { kind: 'success' })
      } else if (kind === 'image') {
        await runOcr(path)
      } else if (kind === 'pdf') {
        const r = await api.request<{ text: string; stats: { empty?: boolean } }>(
          'POST',
          '/api/io/import',
          { path },
          true
        )
        if (r.stats?.empty || !r.text.trim()) {
          // scanned PDF: no text layer, fall back to OCR
          await runOcr(path)
        } else {
          preview.value = {
            title: stem(path),
            path,
            text: r.text,
            source: 'pdf',
            pages: [],
            confidence: null,
            hint: 'استخراج النص من PDF قد يغيّر ترتيب الحروف؛ راجع النص قبل الإنشاء.'
          }
        }
      } else {
        const r = await api.request<{ text: string }>('POST', '/api/io/import', { path }, true)
        if (!r.text.trim())
          return void notify('الملف فارغ؛ لا يوجد نص لاستيراده.', { kind: 'info' })
        await createFromText(stem(path) || baseName(path), r.text)
      }
    } catch (e) {
      notify(e instanceof ApiError ? e.messageAr : 'تعذر استيراد الملف.')
    } finally {
      busy.value = false
    }
  }

  async function confirmPreview(text: string, title: string): Promise<void> {
    preview.value = null
    await createFromText(title.trim() || 'مستند مستورد', text)
  }
  function cancelPreview(): void {
    preview.value = null
  }

  return {
    busy,
    preview,
    ocrFailure,
    batchOpen,
    registerHooks,
    exportAs,
    importFile,
    runOcr,
    confirmPreview,
    cancelPreview,
    createFromText
  }
})
