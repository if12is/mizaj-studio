<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import sampleText from '@fixtures/sample_long.txt?raw'
import { useEditorStore } from '@renderer/stores/editor'
import { useSettingsStore } from '@renderer/stores/settings'

const emit = defineEmits<{ (e: 'change'): void }>()
const editor = useEditorStore()
const settings = useSettingsStore()
const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
let silent = false
let wcTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWordCount(): void {
  if (wcTimer) clearTimeout(wcTimer)
  wcTimer = setTimeout(() => {
    if (view) editor.wordCount = editor.countWords(view.state.doc.toString())
  }, 400)
}

function extensions(): Extension[] {
  return [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.perLineTextDirection.of(true),
    EditorView.contentAttributes.of({ dir: 'rtl', lang: 'ar', 'data-testid': 'editor-content' }),
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) {
        editor.cursorLine = u.state.doc.lineAt(u.state.selection.main.head).number
      }
      if (u.docChanged) {
        scheduleWordCount()
        if (!silent) emit('change')
      }
    })
  ]
}

/** Replace the whole document with a fresh state (resets undo history). */
function setText(text: string, notify = false): void {
  if (!view) return
  silent = !notify
  view.setState(EditorState.create({ doc: text, extensions: extensions() }))
  silent = false
  editor.cursorLine = 1
  editor.wordCount = editor.countWords(text)
  if (notify) emit('change')
}

function loadSample(): void {
  setText(sampleText, true)
}

onMounted(() => {
  view = new EditorView({
    state: EditorState.create({ doc: '', extensions: extensions() }),
    parent: host.value as HTMLDivElement
  })
  editor.register({ getText: () => view?.state.doc.toString() ?? '', setText: (t) => setText(t) })
})
onBeforeUnmount(() => {
  if (wcTimer) clearTimeout(wcTimer)
  editor.register(null)
  view?.destroy()
})
defineExpose({ setText, loadSample })
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col" data-testid="editor">
    <div
      class="flex items-center gap-2 border-b border-slate-200 px-3 py-1 text-xs dark:border-slate-700"
    >
      <button
        class="rounded bg-mizaj-amber/20 px-2 py-1 text-mizaj-amber hover:bg-mizaj-amber/30"
        data-testid="load-sample"
        @click="loadSample"
      >
        تحميل النص التجريبي
      </button>
    </div>
    <div
      ref="host"
      class="mizaj-editor min-h-0 flex-1"
      :class="{ colored: settings.colored }"
      data-testid="editor-host"
    />
  </section>
</template>
