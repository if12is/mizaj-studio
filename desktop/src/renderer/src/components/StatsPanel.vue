<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '@renderer/stores/editor'
import { useProjectsStore } from '@renderer/stores/projects'

const editor = useEditorStore()
const projects = useProjectsStore()
const manual = computed(() => editor.manualEdits[projects.currentDocument?.id ?? 0] ?? 0)
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-6 border-b border-slate-200 bg-slate-50 px-3 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/60"
    data-testid="stats-panel"
  >
    <span
      >الكلمات: <b data-testid="stat-words">{{ editor.wordCount }}</b></span
    >
    <span>
      كثافة الحركات: <b data-testid="stat-density">{{ editor.density.toFixed(1) }}%</b>
    </span>
    <span>
      كلمات معدّلة يدوياً: <b data-testid="stat-manual">{{ manual }}</b>
      <span class="text-slate-500">(للجلسة الحالية)</span>
    </span>
  </div>
</template>
