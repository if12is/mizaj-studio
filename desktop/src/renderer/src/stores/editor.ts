import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { SaveState } from '@renderer/composables/autosave'
import { countWords } from '@renderer/editor/arabic'

export interface EditorAccessor {
  getText(): string
  setText(text: string): void
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
  const showStats = ref(false)
  /** Documents whose autosave must also send diacritized_content. */
  const diacritizedDocs = ref<Record<number, boolean>>({})
  /** Words edited manually through the inspector, per document. In memory only
   *  (not persisted: resets when the app restarts). */
  const manualEdits = ref<Record<number, number>>({})

  function register(a: EditorAccessor | null): void {
    accessor.value = a
  }
  function addManualEdits(docId: number, n: number): void {
    manualEdits.value = { ...manualEdits.value, [docId]: (manualEdits.value[docId] ?? 0) + n }
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
    showStats,
    diacritizedDocs,
    manualEdits,
    register,
    addManualEdits,
    countWords
  }
})
