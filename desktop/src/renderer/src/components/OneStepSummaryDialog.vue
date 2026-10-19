<script setup lang="ts">
import { computed } from 'vue'
import ModalShell from '@renderer/components/files/ModalShell.vue'
import { useProofreadStore } from '@renderer/stores/proofread'
import { useFileStore } from '@renderer/stores/fileio'
import { summaryLine } from '@renderer/proofread/oneStep'

/** The single closing summary of «تدقيق وتشكيل» (one step). */
const proofread = useProofreadStore()
const files = useFileStore()
const line = computed(() => (proofread.summary ? summaryLine(proofread.summary) : ''))
const doubtful = computed(() => proofread.summary?.doubtful ?? 0)

const close = (): void => {
  proofread.summary = null
}
function review(): void {
  close()
  proofread.reviewRequest++
}
function exportWord(): void {
  close()
  void files.exportAs('docx')
}
const btn =
  'rounded border px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50'
</script>

<template>
  <ModalShell title="اكتمل التدقيق والتشكيل" testid="onestep-summary" @close="close">
    <p class="text-base leading-8" data-testid="onestep-summary-text">{{ line }}</p>
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <button
        :class="btn"
        :disabled="!doubtful"
        :title="doubtful ? undefined : 'لا توجد كلمات مشكوك فيها'"
        data-testid="onestep-review"
        @click="review"
      >
        مراجعة المشكوك فيه
      </button>
      <button :class="btn" data-testid="onestep-export" @click="exportWord">تصدير Word</button>
      <span class="flex-1" />
      <button
        class="rounded bg-mizaj-emerald px-3 py-1 text-sm font-semibold text-white"
        data-testid="onestep-close-btn"
        @click="close"
      >
        إغلاق
      </button>
    </div>
  </ModalShell>
</template>
