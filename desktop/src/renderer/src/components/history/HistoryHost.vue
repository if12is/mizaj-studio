<script setup lang="ts">
/**
 * Mounting hook for the edit history: owns the Ctrl+Shift+H shortcut, keeps the timeline in
 * step with saves and document switches, and renders the panel. App.vue only mounts this.
 */
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useEditorStore } from '@renderer/stores/editor'
import { useHistoryStore } from '@renderer/stores/history'
import HistoryPanel from './HistoryPanel.vue'

const props = defineProps<{ flush: () => Promise<void> }>()
const history = useHistoryStore()
const editor = useEditorStore()

function onKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.code === 'KeyH' || e.key === 'H')) {
    e.preventDefault()
    if (history.docId !== null || history.open) void history.toggle()
  }
}

onMounted(() => {
  history.registerFlush(props.flush)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  history.registerFlush(null)
})

// another document: the old timeline no longer applies
watch(
  () => history.docId,
  () => {
    history.selectedId = null
    history.diff = null
    if (history.open) void history.load()
  }
)
// a finished save may have added an entry
watch(
  () => editor.saveState,
  (s) => {
    if (s === 'saved' && history.open) void history.load()
  }
)
</script>

<template>
  <HistoryPanel v-if="history.open" />
</template>
