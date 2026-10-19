<script setup lang="ts">
import { useLearningStore } from '@renderer/stores/learning'

const learning = useLearningStore()
</script>

<template>
  <div
    v-if="learning.prompt"
    class="fixed bottom-10 start-4 z-40 max-w-sm rounded-lg border border-mizaj-emerald/50 bg-white p-3 text-xs shadow-lg dark:bg-slate-800"
    role="status"
    aria-live="polite"
    data-testid="learn-prompt"
  >
    <div class="mb-2 font-bold">
      حفظ هذا التشكيل؟
      <span class="ms-1 font-normal" dir="rtl" data-testid="learn-form">{{
        learning.prompt.form
      }}</span>
    </div>
    <div class="flex flex-wrap gap-2">
      <button
        class="rounded bg-mizaj-emerald px-2 py-0.5 text-white"
        data-testid="learn-dict"
        @click="learning.saveToDictionary()"
      >
        في قاموسي
      </button>
      <button
        :disabled="learning.prompt.repeats === 0"
        class="rounded border px-2 py-0.5 disabled:opacity-50"
        data-testid="learn-repeats"
        @click="learning.applyToRepeats()"
      >
        طبّقه على التكرارات في هذا الملف ({{ learning.prompt.repeats }})
      </button>
      <button
        class="rounded border px-2 py-0.5"
        data-testid="learn-ignore"
        @click="learning.dismiss()"
      >
        تجاهل
      </button>
    </div>
  </div>
</template>
