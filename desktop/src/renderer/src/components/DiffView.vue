<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { MergeView } from '@codemirror/merge'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { useEditorStore } from '@renderer/stores/editor'

const editor = useEditorStore()
const host = ref<HTMLDivElement | null>(null)
let mv: MergeView | null = null

const ext = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.lineWrapping,
  EditorView.perLineTextDirection.of(true),
  EditorView.contentAttributes.of({ dir: 'rtl', lang: 'ar' })
]

onMounted(() => {
  const current = editor.accessor?.getText() ?? ''
  // Both panes live in one scroll container (.cm-mergeView), so they scroll in sync.
  mv = new MergeView({
    a: { doc: editor.diffBase ?? current, extensions: ext },
    b: { doc: current, extensions: ext },
    parent: host.value as HTMLElement,
    collapseUnchanged: { margin: 3, minSize: 6 },
    gutter: false
  })
})
onBeforeUnmount(() => mv?.destroy())
</script>

<template>
  <div class="mizaj-diff mizaj-editor min-h-0 flex-1" data-testid="diff-view">
    <div class="flex border-b border-slate-200 px-3 py-1 text-xs dark:border-slate-700">
      <span class="flex-1">الأصلي</span>
      <span class="flex-1">المشكول</span>
    </div>
    <div ref="host" class="h-full" data-testid="diff-host" />
  </div>
</template>
