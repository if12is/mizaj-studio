<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import TafqeetTool from './legal/TafqeetTool.vue'
import DateTool from './legal/DateTool.vue'
import LegalChecks from './legal/LegalChecks.vue'
import TemplatesTool from './legal/TemplatesTool.vue'
import LintTool from './legal/LintTool.vue'
import CitationsTool from './legal/CitationsTool.vue'
import RedactTool from './legal/RedactTool.vue'
import CompareTool from './legal/CompareTool.vue'
import { useEditorStore } from '@renderer/stores/editor'

defineProps<{ openDocument: (id: number) => Promise<void> }>()
type Tab = 'tafqeet' | 'date' | 'checks' | 'lint' | 'citations' | 'redact' | 'compare' | 'templates'
const tab = ref<Tab>('tafqeet')
const tabs: readonly (readonly [Tab, string])[] = [
  ['tafqeet', 'تفقيط'],
  ['date', 'التاريخ'],
  ['checks', 'الفحص'],
  ['lint', 'فحص الصياغة'],
  ['citations', 'الاستشهادات'],
  ['redact', 'إخفاء البيانات'],
  ['compare', 'مقارنة نسختين'],
  ['templates', 'القوالب']
]
// the side-by-side comparison needs a wider panel
const editor = useEditorStore()
watch(tab, (t) => (editor.legalWide = t === 'compare'), { immediate: true })
onBeforeUnmount(() => (editor.legalWide = false))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="legal-panel">
    <div class="flex flex-wrap border-b dark:border-slate-700" role="tablist">
      <button
        v-for="[k, label] in tabs"
        :key="k"
        class="flex-1 whitespace-nowrap px-2 py-1 text-sm"
        role="tab"
        :aria-selected="tab === k"
        :class="tab === k ? 'border-b-2 border-mizaj-emerald font-semibold' : ''"
        :data-testid="`legal-tab-${k}`"
        @click="tab = k"
      >
        {{ label }}
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <TafqeetTool v-if="tab === 'tafqeet'" />
      <DateTool v-else-if="tab === 'date'" />
      <LegalChecks v-else-if="tab === 'checks'" />
      <LintTool v-else-if="tab === 'lint'" />
      <CitationsTool v-else-if="tab === 'citations'" />
      <RedactTool v-else-if="tab === 'redact'" :open-document="openDocument" />
      <CompareTool v-else-if="tab === 'compare'" />
      <TemplatesTool v-else :open-document="openDocument" />
    </div>
  </div>
</template>
