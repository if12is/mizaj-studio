<script setup lang="ts">
/** Toolbar button that opens «سجل التعديلات» (Ctrl+Shift+H). */
import { useHistoryStore } from '@renderer/stores/history'
import ToolbarToggle from '../ui/ToolbarToggle.vue'

const history = useHistoryStore()
</script>

<template>
  <ToolbarToggle
    :on="history.open"
    panel
    name="سجل التعديلات"
    icon="history"
    shortcut="Ctrl+Shift+H"
    :disabled-reason="history.docId === null ? 'افتح مستنداً أولاً' : undefined"
    data-testid="toolbar-history"
    @click="history.toggle()"
  >
    سجل التعديلات
  </ToolbarToggle>
</template>
