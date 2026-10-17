<script setup lang="ts">
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import { describeHemistich, METER_FEET, type ArudResult } from '@renderer/editor/meters'
import { useEditorStore } from '@renderer/stores/editor'
import { useQualityStore } from '@renderer/stores/quality'
import { useSettingsStore } from '@renderer/stores/settings'

const editor = useEditorStore()
const quality = useQualityStore()
const settings = useSettingsStore()
const result = ref<ArudResult | null>(null)
const busy = ref(false)

async function analyze(scope: 'line' | 'all'): Promise<void> {
  const acc = editor.accessor
  if (!acc) return
  const text = scope === 'line' ? acc.currentLine() : acc.selectionInfo().text
  if (!text.trim()) return
  busy.value = true
  try {
    result.value = await useApi().post<ArudResult>('/api/arud/analyze', {
      text: text.split('\n').slice(0, 400).join('\n'),
      mode: settings.values.engine_mode
    })
  } catch {
    result.value = null
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 text-sm"
    data-testid="poetry-panel"
  >
    <label class="flex items-center gap-2">
      <input
        type="checkbox"
        :checked="quality.poetryOn"
        :disabled="!quality.poetryOn && false"
        data-testid="poetry-toggle-panel"
        @change="quality.setPoetry(($event.target as HTMLInputElement).checked)"
      />
      وضع الشعر لهذا المستند (يُحفظ هيكل الأبيات في التشكيل)
    </label>
    <div class="flex flex-wrap gap-2">
      <button
        class="rounded border px-2 py-1 dark:border-slate-600"
        :disabled="busy"
        data-testid="poetry-analyze-line"
        @click="analyze('line')"
      >
        تحليل البحر للسطر الحالي
      </button>
      <button
        class="rounded bg-mizaj-emerald px-2 py-1 text-white"
        :disabled="busy"
        data-testid="poetry-analyze-all"
        @click="analyze('all')"
      >
        تحليل المحدد / المستند
      </button>
    </div>
    <div v-if="result" class="space-y-2" data-testid="poetry-result">
      <p>
        البحر:
        <b data-testid="poetry-meter">{{ result.meter ?? 'غير معروف' }}</b>
        <span class="text-xs text-slate-500">
          ({{ result.matched_hemistichs }} من {{ result.hemistichs }} شطر)</span
        >
      </p>
      <p v-if="result.meter" class="font-editor" data-testid="poetry-feet">
        التفعيلات (للشطر): {{ METER_FEET[result.meter]?.join(' — ') }}
      </p>
      <p v-if="result.diacritized" class="text-xs text-mizaj-amber">
        شُكّل النص تلقائياً قبل التحليل؛ راجع التشكيل لأن البحر يعتمد عليه.
      </p>
      <ul class="space-y-1">
        <li
          v-for="(v, vi) in result.verses"
          :key="vi"
          class="rounded border p-2 dark:border-slate-600"
          data-testid="poetry-verse"
        >
          <div v-for="(h, hi) in v.hemistichs" :key="hi">
            <span class="font-editor">{{ h.text }}</span>
            <span class="block text-xs text-slate-500">{{ describeHemistich(h) }}</span>
          </div>
        </li>
      </ul>
      <p v-if="result.limits" class="text-xs text-slate-500">{{ result.limits }}</p>
    </div>
  </div>
</template>
