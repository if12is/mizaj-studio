import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { SaveState } from '@renderer/composables/autosave'
import { countWords } from '@renderer/editor/arabic'
import { useApi } from '@renderer/api'
import {
  addManualEdit,
  emptyManualEdits,
  manualEditsKey,
  parseManualEdits,
  serializeManualEdits,
  type ManualEdits
} from '@renderer/editor/manualEdits'

export interface EditorAccessor {
  getText(): string
  setText(text: string): void
  /** insert at the cursor (replacing the selection) as one transaction */
  insertText(text: string): void
  /** replace [from,to) only if it still equals `expected`; one transaction. false = stale */
  applyEdit(from: number, to: number, expected: string, insert: string): boolean
  jumpTo(from: number, to: number): void
  spellNav(dir: 1 | -1): void
}

export type RunState = 'idle' | 'waiting' | 'running' | 'paused' | 'done'

export const useEditorStore = defineStore('editor', () => {
  const saveState = ref<SaveState>('saved')
  const wordCount = ref(0)
  const cursorLine = ref(1)
  const density = ref(0)
  // The document itself lives in CodeMirror; only an accessor is kept here.
  const accessor = shallowRef<EditorAccessor | null>(null)

  const runState = ref<RunState>('idle')
  const progress = ref(0)
  const wps = ref(0)
  /** Text before the last diacritization run (left side of the diff view). */
  const diffBase = ref<string | null>(null)
  const showDiff = ref(false)
  const rightPanel = ref<'spelling' | 'legal' | null>(null)
  const showStats = ref(false)
  /** Documents whose autosave must also send diacritized_content. */
  const diacritizedDocs = ref<Record<number, boolean>>({})
  /** Words edited manually through the inspector, per document. Persisted in the settings
   *  table under `manual_edits:<document_id>` (JSON {count, words}). */
  const manualEdits = ref<Record<number, ManualEdits>>({})

  function register(a: EditorAccessor | null): void {
    accessor.value = a
  }
  /** Load a document's persisted record from the already-fetched settings map. */
  function loadManualEdits(docId: number, settings: Record<string, string>): void {
    if (docId in manualEdits.value) return // newer than the settings snapshot
    manualEdits.value = {
      ...manualEdits.value,
      [docId]: parseManualEdits(settings[manualEditsKey(docId)])
    }
  }
  function addManualEdits(docId: number, n: number, bareWord: string): void {
    const next = addManualEdit(manualEdits.value[docId] ?? emptyManualEdits(), n, bareWord)
    manualEdits.value = { ...manualEdits.value, [docId]: next }
    if (docId > 0) {
      void useApi()
        .put('/api/settings', { [manualEditsKey(docId)]: serializeManualEdits(next) }, true)
        .catch(() => {})
    }
  }
  return {
    saveState,
    wordCount,
    cursorLine,
    density,
    accessor,
    runState,
    progress,
    wps,
    diffBase,
    showDiff,
    rightPanel,
    showStats,
    diacritizedDocs,
    manualEdits,
    register,
    addManualEdits,
    loadManualEdits,
    countWords
  }
})
