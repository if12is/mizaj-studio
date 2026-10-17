<script setup lang="ts">
import { useReducedMotion } from '@renderer/lib/motion'
import { onBeforeUnmount, ref, watch } from 'vue'
import { lazyPanel } from '@renderer/lib/lazy'
import { useEditorStore } from '@renderer/stores/editor'

// one chunk per tool; the tool code loads when its tab is first opened
const reduced = useReducedMotion()
const TafqeetTool = lazyPanel(() => import('./legal/TafqeetTool.vue'))
const DateTool = lazyPanel(() => import('./legal/DateTool.vue'))
const LegalChecks = lazyPanel(() => import('./legal/LegalChecks.vue'))
const TemplatesTool = lazyPanel(() => import('./legal/TemplatesTool.vue'))
const LintTool = lazyPanel(() => import('./legal/LintTool.vue'))
const CitationsTool = lazyPanel(() => import('./legal/CitationsTool.vue'))
const RedactTool = lazyPanel(() => import('./legal/RedactTool.vue'))
const CompareTool = lazyPanel(() => import('./legal/CompareTool.vue'))

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
    <div class="relative min-h-0 flex-1 overflow-auto">
      <Transition name="m-tab" :mode="reduced ? undefined : 'out-in'" :css="!reduced">
        <div :key="tab">
          <TafqeetTool v-if="tab === 'tafqeet'" />
          <DateTool v-else-if="tab === 'date'" />
          <LegalChecks v-else-if="tab === 'checks'" />
          <LintTool v-else-if="tab === 'lint'" />
          <CitationsTool v-else-if="tab === 'citations'" />
          <RedactTool v-else-if="tab === 'redact'" :open-document="openDocument" />
          <CompareTool v-else-if="tab === 'compare'" />
          <TemplatesTool v-else :open-document="openDocument" />
        </div>
      </Transition>
    </div>
  </div>
</template>
