<script setup lang="ts">
import { ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { OCR_LEVEL_LABEL, confidenceLevel } from '@renderer/files/formats'
import { useFileStore, type ImportPreview } from '@renderer/stores/fileio'

const props = defineProps<{ preview: ImportPreview }>()
const files = useFileStore()
const text = ref(props.preview.text)
const title = ref(props.preview.title)
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
const badge = {
  high: 'bg-emerald-600',
  medium: 'bg-amber-600',
  low: 'bg-red-600',
  none: 'bg-slate-500'
}
</script>

<template>
  <ModalShell
    :title="props.preview.source === 'ocr' ? 'مراجعة نص المسح الضوئي (OCR)' : 'مراجعة نص PDF'"
    testid="import-preview"
    wide
    @close="files.cancelPreview()"
  >
    <div class="space-y-2 text-sm">
      <p v-if="props.preview.hint" class="text-mizaj-amber" data-testid="import-hint">
        {{ props.preview.hint }}
      </p>
      <p v-if="props.preview.source === 'ocr'" class="text-xs text-slate-500">
        أخطاء التعرف الضوئي تشبه الأخطاء الإملائية؛ صحّح النص أدناه قبل إنشاء المستند.
      </p>
      <div v-if="props.preview.pages.length" class="flex flex-wrap gap-2" data-testid="ocr-pages">
        <span
          v-for="p in props.preview.pages"
          :key="p.page"
          class="rounded px-2 py-0.5 text-xs text-white"
          :class="badge[confidenceLevel(p.confidence)]"
          :title="OCR_LEVEL_LABEL[confidenceLevel(p.confidence)]"
          data-testid="ocr-page-confidence"
          :data-level="confidenceLevel(p.confidence)"
        >
          صفحة {{ p.page }}:
          {{ p.confidence === null ? 'نص مضمّن' : `${p.confidence}%` }}
        </span>
      </div>
      <p v-if="props.preview.confidence !== null" data-testid="ocr-confidence">
        متوسط الثقة: {{ props.preview.confidence }}%
      </p>
      <label class="block">
        <span class="font-semibold">عنوان المستند</span>
        <input v-model="title" :class="field" class="mt-1 w-full" data-testid="import-title" />
      </label>
      <textarea
        v-model="text"
        class="font-editor h-72 w-full rounded border p-2 dark:border-slate-600 dark:bg-slate-900"
        dir="rtl"
        aria-label="النص المستخرج"
        data-testid="import-text"
      />
      <div class="flex gap-2">
        <button
          class="rounded bg-mizaj-emerald px-3 py-1 text-white"
          data-testid="import-confirm"
          @click="files.confirmPreview(text, title)"
        >
          إنشاء مستند
        </button>
        <button
          class="rounded border px-3 py-1 dark:border-slate-600"
          data-testid="import-cancel"
          @click="files.cancelPreview()"
        >
          إلغاء
        </button>
      </div>
    </div>
  </ModalShell>
</template>
