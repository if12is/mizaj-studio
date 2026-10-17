import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import {
  buildCitationEdits,
  buildLintIssues,
  buildRedactionEdits,
  combineEdits,
  applyTextEdits,
  defaultSelection,
  type CmpHunk,
  type CmpRow,
  type LintIssue,
  type RawCitationSuggestion,
  type RawLintIssue,
  type RawRedaction,
  type RedactionEdit,
  type TextEdit
} from '@renderer/legal/tools'
import { makeCpToUtf16 } from '@renderer/editor/offsets'
import { useEditorStore } from './editor'
import { useProjectsStore } from './projects'

const STALE = 'تغيّر النص منذ الفحص؛ أعد الفحص ثم طبّق الاقتراح.'

/**
 * Apply many edits as ONE transaction (one undo step). Prefers a native multi-edit accessor
 * method when the editor provides one, otherwise collapses them into a single verified range.
 */
export function applyEditsToEditor(edits: TextEdit[]): { applied: number; skipped: number } | null {
  const acc = useEditorStore().accessor as
    | (NonNullable<ReturnType<typeof useEditorStore>['accessor']> & {
        applyEdits?: (e: TextEdit[]) => boolean
      })
    | null
  if (!acc) return null
  const text = acc.getText()
  const c = combineEdits(text, edits)
  if (!c) return null
  const ok = acc.applyEdits
    ? acc.applyEdits(edits)
    : acc.applyEdit(c.edit.from, c.edit.to, c.edit.expected, c.edit.insert)
  return ok ? { applied: c.applied, skipped: c.skipped } : null
}

// ---------------------------------------------------------------- lint
interface LintRule {
  id: string
  severity: string
  title_ar: string
}
interface LintResponse {
  issues: RawLintIssue[]
  count: number
  by_rule: Record<string, number>
  modalities: { start: number; end: number; kinds: string[] }[]
  disclaimer_ar: string
  structure?: {
    title_ar: string
    found: { id: string; label_ar: string }[]
    missing: { id: string; label_ar: string }[]
    note_ar: string
  }
}

export const useLintStore = defineStore('lint', () => {
  const rules = ref<LintRule[]>([])
  const docTypes = ref<{ id: string; title_ar: string }[]>([])
  const docType = ref('')
  const disabled = ref<string[]>([])
  const issues = shallowRef<LintIssue[]>([])
  const result = ref<LintResponse | null>(null)
  const running = ref(false)

  async function loadRules(): Promise<void> {
    if (rules.value.length) return
    try {
      const r = await useApi().get<{
        rules: LintRule[]
        doc_types: { id: string; title_ar: string }[]
      }>('/api/legal/lint/rules', true)
      rules.value = r.rules
      docTypes.value = r.doc_types
    } catch {
      /* offline backend hiccup: leave empty */
    }
  }
  function toggleRule(id: string, on: boolean): void {
    disabled.value = on
      ? disabled.value.filter((x) => x !== id)
      : [...new Set([...disabled.value, id])]
  }

  async function run(): Promise<void> {
    const acc = useEditorStore().accessor
    if (!acc) return
    const text = acc.getText()
    running.value = true
    try {
      const r = await useApi().post<LintResponse>('/api/legal/lint', {
        text,
        disabled: disabled.value,
        ...(docType.value ? { doc_type: docType.value } : {})
      })
      result.value = r
      issues.value = buildLintIssues(text, r.issues)
    } catch {
      /* toast shown */
    } finally {
      running.value = false
    }
  }

  function jump(i: { from: number; to: number }): void {
    useEditorStore().accessor?.jumpTo(i.from, i.to)
  }

  return {
    rules,
    docTypes,
    docType,
    disabled,
    issues,
    result,
    running,
    loadRules,
    toggleRule,
    run,
    jump
  }
})

// ---------------------------------------------------------------- citations
interface CitationsResponse {
  laws: { text: string; normalized: string; start: number; end: number }[]
  cases: { text: string; start: number; end: number }[]
  articles: { text: string; normalized: string; start: number; end: number }[]
  quran: unknown[]
  issues: {
    type?: string
    kind?: string
    severity?: string
    message_ar: string
    start: number
    end: number
  }[]
  suggestions: RawCitationSuggestion[]
  index_loaded: boolean
  disclaimer_ar: string
}
export interface CitationEdit extends TextEdit {
  kind: string
}
export interface CitationIssue {
  message_ar: string
  severity: string
  from: number
  to: number
  text: string
}

export const useCitationsStore = defineStore('citations', () => {
  const style = ref<'paren' | 'plain'>('paren')
  const useIndex = ref(true)
  const result = ref<CitationsResponse | null>(null)
  const edits = shallowRef<CitationEdit[]>([])
  const found = shallowRef<CitationIssue[]>([])
  const running = ref(false)
  const indexCount = ref<number | null>(null)

  async function run(): Promise<void> {
    const acc = useEditorStore().accessor
    if (!acc) return
    const text = acc.getText()
    running.value = true
    try {
      const r = await useApi().post<CitationsResponse>('/api/legal/citations', {
        text,
        style: style.value,
        use_index: useIndex.value
      })
      result.value = r
      edits.value = buildCitationEdits(text, r.suggestions)
      const conv = makeCpToUtf16(text)
      found.value = r.issues.map((i) => {
        const from = conv(i.start)
        const to = conv(i.end)
        return {
          message_ar: i.message_ar,
          severity: i.severity ?? 'warning',
          from,
          to,
          text: text.slice(from, to)
        }
      })
    } catch {
      /* toast shown */
    } finally {
      running.value = false
    }
  }

  async function applyOne(e: CitationEdit): Promise<void> {
    const ok = useEditorStore().accessor?.applyEdit(e.from, e.to, e.expected, e.insert)
    if (!ok) return void notify(STALE, { kind: 'info' })
    await run()
  }
  async function applyAll(): Promise<void> {
    const r = applyEditsToEditor(edits.value)
    if (!r) return void notify(STALE, { kind: 'info' })
    notify(`طُبّق ${r.applied} اقتراحاً${r.skipped ? ` وتُخطّي ${r.skipped}` : ''}.`, {
      kind: 'success'
    })
    await run()
  }

  async function loadIndex(): Promise<void> {
    try {
      const r = await useApi().get<{ laws: unknown[] }>('/api/legal/law-index', true)
      indexCount.value = r.laws.length
    } catch {
      indexCount.value = null
    }
  }
  async function importIndex(json: string): Promise<void> {
    try {
      const data = JSON.parse(json)
      const r = await useApi().request<{ count: number }>('PUT', '/api/legal/law-index', data, true)
      notify(`تم استيراد فهرس يضم ${r.count} قانوناً.`, { kind: 'success' })
      await loadIndex()
    } catch {
      notify('ملف فهرس القوانين غير صالح.')
    }
  }
  async function exportIndex(): Promise<void> {
    const data = await useApi().get('/api/legal/law-index')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    )
    a.download = 'mizaj-law-index.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  async function clearIndex(): Promise<void> {
    await useApi().del('/api/legal/law-index')
    await loadIndex()
  }

  return {
    style,
    useIndex,
    result,
    edits,
    found,
    running,
    indexCount,
    run,
    applyOne,
    applyAll,
    loadIndex,
    importIndex,
    exportIndex,
    clearIndex
  }
})

// ---------------------------------------------------------------- redaction
interface RedactResponse {
  edits: RawRedaction[]
  counts: Record<string, number>
  warning_ar: string
}

export const useRedactStore = defineStore('redact', () => {
  const categories = ref<string[]>([
    'id',
    'phone',
    'email',
    'iban',
    'card',
    'passport',
    'name',
    'party'
  ])
  const style = ref<'mask' | 'placeholder' | 'pseudonym'>('placeholder')
  const names = ref('')
  const useParties = ref(true)
  const edits = shallowRef<RedactionEdit[]>([])
  const selected = ref<number[]>([])
  const snapshot = ref('')
  const warning = ref('')
  const ran = ref(false)
  const running = ref(false)

  async function run(): Promise<void> {
    const acc = useEditorStore().accessor
    if (!acc) return
    const text = acc.getText()
    running.value = true
    try {
      const r = await useApi().post<RedactResponse>('/api/legal/redact', {
        text,
        categories: categories.value,
        style: style.value,
        names: names.value
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        use_parties: useParties.value
      })
      snapshot.value = text
      edits.value = buildRedactionEdits(text, r.edits)
      selected.value = defaultSelection(edits.value)
      warning.value = r.warning_ar
      ran.value = true
    } catch {
      /* toast shown */
    } finally {
      running.value = false
    }
  }

  const chosen = (): RedactionEdit[] => edits.value.filter((e) => selected.value.includes(e.id))

  function toggle(id: number, on: boolean): void {
    selected.value = on
      ? [...new Set([...selected.value, id])]
      : selected.value.filter((x) => x !== id)
  }
  function jump(e: RedactionEdit): void {
    useEditorStore().accessor?.jumpTo(e.from, e.to)
  }

  /** Apply the selected proposals to the open document as one undoable transaction. */
  function applyToDocument(): void {
    const r = applyEditsToEditor(chosen())
    if (!r) return void notify(STALE, { kind: 'info' })
    notify(`أُخفي ${r.applied} موضعاً في المستند${r.skipped ? ` (تُخطّي ${r.skipped})` : ''}.`, {
      kind: 'success'
    })
    edits.value = []
    selected.value = []
    ran.value = false
  }

  /** Create a NEW document with the redactions; the original document is not touched. */
  async function saveRedactedCopy(openDocument: (id: number) => Promise<void>): Promise<void> {
    const projects = useProjectsStore()
    const cur = projects.currentDocument
    const pid = cur?.project_id ?? projects.currentProjectId ?? projects.projects[0]?.id
    if (pid === undefined) return void notify('أنشئ مشروعاً أولاً.')
    const { text, applied } = applyTextEdits(snapshot.value, chosen())
    const d = await projects.createDocument(pid, `${cur?.title ?? 'مستند'} (مُخفى)`, text)
    notify(`أُنشئت نسخة مُخفاة (${applied} موضعاً)؛ المستند الأصلي لم يتغير.`, { kind: 'success' })
    await openDocument(d.id)
  }

  return {
    categories,
    style,
    names,
    useParties,
    edits,
    selected,
    snapshot,
    warning,
    ran,
    running,
    run,
    chosen,
    toggle,
    jump,
    applyToDocument,
    saveRedactedCopy
  }
})

// ---------------------------------------------------------------- compare
interface CompareResponse {
  identical: boolean
  hunks: CmpHunk[]
  aligned: CmpRow[]
  counts: Record<string, number>
  summary: {
    substantive: {
      hunk: number
      categories: string[]
      type: string
      a_text: string
      b_text: string
    }[]
    by_category: Record<string, number>
    words_a: number
    words_b: number
  }
  note_ar: string
}

export const useCompareStore = defineStore('compare', () => {
  const result = ref<CompareResponse | null>(null)
  const running = ref(false)
  const showFormat = ref(false)
  const showEqual = ref(false)

  async function run(
    a: { text?: string; doc?: number },
    b: { text?: string; doc?: number }
  ): Promise<void> {
    running.value = true
    try {
      result.value = await useApi().post<CompareResponse>('/api/legal/compare', {
        ...(a.doc !== undefined ? { document_a: a.doc } : { a: a.text ?? '' }),
        ...(b.doc !== undefined ? { document_b: b.doc } : { b: b.text ?? '' })
      })
    } catch {
      /* toast shown */
    } finally {
      running.value = false
    }
  }
  return { result, running, showFormat, showEqual, run }
})
