import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { SaveState } from '@renderer/composables/autosave'

export interface EditorAccessor {
  getText(): string
  setText(text: string): void
}

export const useEditorStore = defineStore('editor', () => {
  const saveState = ref<SaveState>('saved')
  const wordCount = ref(0)
  const cursorLine = ref(1)
  // The document itself lives in CodeMirror; only an accessor is kept here.
  const accessor = shallowRef<EditorAccessor | null>(null)

  function register(a: EditorAccessor | null): void {
    accessor.value = a
  }
  function countWords(text: string): number {
    const m = text.match(/\S+/g)
    return m ? m.length : 0
  }
  return { saveState, wordCount, cursorLine, accessor, register, countWords }
})
