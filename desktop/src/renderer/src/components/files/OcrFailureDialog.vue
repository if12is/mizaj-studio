<script setup lang="ts">
import ModalShell from './ModalShell.vue'
import { openExternal } from '@renderer/lib/native'
import { useFileStore } from '@renderer/stores/fileio'

const files = useFileStore()
</script>

<template>
  <ModalShell
    v-if="files.ocrFailure"
    title="تعذر التعرف الضوئي"
    testid="ocr-failure"
    @close="files.ocrFailure = null"
  >
    <div class="space-y-2 text-sm">
      <p class="text-red-500" role="alert" data-testid="ocr-failure-text">
        {{ files.ocrFailure.text }}
      </p>
      <p
        v-if="files.ocrFailure.hint"
        class="rounded border p-2 text-xs dark:border-slate-600"
        dir="auto"
        data-testid="ocr-install-hint"
      >
        {{ files.ocrFailure.hint }}
      </p>
      <p v-if="files.ocrFailure.missing" class="text-xs text-slate-500">
        بعد التثبيت اضغط «إعادة المحاولة». (الأداة تعمل على جهازك فقط ولا يُرسل شيء عبر الشبكة.)
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          v-if="files.ocrFailure.missing"
          class="rounded border px-3 py-1 dark:border-slate-600"
          data-testid="ocr-download-link"
          @click="openExternal('https://github.com/UB-Mannheim/tesseract/wiki')"
        >
          صفحة تنزيل Tesseract (متصفح خارجي)
        </button>
        <button
          class="rounded bg-mizaj-emerald px-3 py-1 text-white"
          data-testid="ocr-retry"
          @click="files.runOcr(files.ocrFailure.path)"
        >
          إعادة المحاولة
        </button>
        <button
          class="rounded border px-3 py-1 dark:border-slate-600"
          data-testid="ocr-failure-dismiss"
          @click="files.ocrFailure = null"
        >
          إغلاق
        </button>
      </div>
    </div>
  </ModalShell>
</template>
