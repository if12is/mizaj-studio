<script setup lang="ts">
/** Toolbar button that opens «سجل التعديلات» (Ctrl+Shift+H). */
import { useHistoryStore } from '@renderer/stores/history'

const history = useHistoryStore()
</script>

<template>
  <button
    class="rounded border px-2 py-1 hover:bg-slate-200 dark:border-slate-600 dark:hover:bg-slate-700"
    :class="history.open ? 'border-mizaj-emerald' : ''"
    data-testid="toolbar-history"
    title="Ctrl+Shift+H"
    :aria-pressed="history.open"
    :disabled="history.docId === null"
    @click="history.toggle()"
  >
    سجل التعديلات
  </button>
</template>
