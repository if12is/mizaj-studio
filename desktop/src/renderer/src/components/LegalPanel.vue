<script setup lang="ts">
import { ref } from 'vue'
import TafqeetTool from './legal/TafqeetTool.vue'
import DateTool from './legal/DateTool.vue'
import LegalChecks from './legal/LegalChecks.vue'
import TemplatesTool from './legal/TemplatesTool.vue'

defineProps<{ openDocument: (id: number) => Promise<void> }>()
const tab = ref<'tafqeet' | 'date' | 'checks' | 'templates'>('tafqeet')
const tabs = [
  ['tafqeet', 'تفقيط'],
  ['date', 'التاريخ'],
  ['checks', 'الفحص'],
  ['templates', 'القوالب']
] as const
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="legal-panel">
    <div class="flex border-b dark:border-slate-700">
      <button
        v-for="[k, label] in tabs"
        :key="k"
        class="flex-1 px-2 py-1 text-sm"
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
      <TemplatesTool v-else :open-document="openDocument" />
    </div>
  </div>
</template>
