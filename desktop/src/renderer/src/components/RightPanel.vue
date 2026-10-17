<script setup lang="ts">
import { useEditorStore } from '@renderer/stores/editor'
import LegalPanel from './LegalPanel.vue'
import SpellingPanel from './SpellingPanel.vue'

defineProps<{ openDocument: (id: number) => Promise<void> }>()
const editor = useEditorStore()
</script>

<template>
  <aside
    v-if="editor.rightPanel"
    class="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60"
    data-testid="right-panel"
    :data-panel="editor.rightPanel"
  >
    <div class="flex items-center justify-between border-b px-3 py-1 dark:border-slate-700">
      <h2 class="text-sm font-semibold">
        {{ editor.rightPanel === 'legal' ? 'أدوات قانونية' : 'قائمة الأخطاء الإملائية' }}
      </h2>
      <button aria-label="إغلاق" data-testid="right-panel-close" @click="editor.rightPanel = null">
        ✕
      </button>
    </div>
    <LegalPanel v-if="editor.rightPanel === 'legal'" :open-document="openDocument" />
    <SpellingPanel v-else />
  </aside>
</template>
