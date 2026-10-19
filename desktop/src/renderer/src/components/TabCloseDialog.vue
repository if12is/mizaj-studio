<script setup lang="ts">
/** «Unsaved changes» prompt shown before a tab with unsaved work is closed. */
import { ref } from 'vue'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'

defineProps<{ title: string }>()
const emit = defineEmits<{ (e: 'resolve', choice: 'save' | 'discard' | 'cancel'): void }>()
const el = ref<HTMLElement | null>(null)
useFocusTrap(el, () => emit('resolve', 'cancel'))
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    data-testid="tab-close-backdrop"
    @click.self="emit('resolve', 'cancel')"
  >
    <div
      ref="el"
      class="w-[26rem] max-w-[95vw] rounded-lg border border-slate-300 bg-white p-4 text-slate-900 shadow-xl dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="tab-close-title"
      aria-describedby="tab-close-message"
      data-testid="tab-close-dialog"
    >
      <h2 id="tab-close-title" class="mb-2 text-lg font-bold">تغييرات غير محفوظة</h2>
      <p id="tab-close-message" class="mb-4 text-sm">
        المستند «{{ title }}» يحتوي على تغييرات لم تُحفظ بعد. هل تريد حفظها قبل الإغلاق؟
      </p>
      <div class="flex justify-end gap-2">
        <button
          class="rounded border px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
          data-testid="tab-close-cancel"
          @click="emit('resolve', 'cancel')"
        >
          إلغاء
        </button>
        <button
          class="rounded border px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
          data-testid="tab-close-discard"
          @click="emit('resolve', 'discard')"
        >
          لا تحفظ
        </button>
        <button
          class="rounded bg-mizaj-emerald px-3 py-1 text-sm text-white"
          data-testid="tab-close-save"
          @click="emit('resolve', 'save')"
        >
          حفظ وإغلاق
        </button>
      </div>
    </div>
  </div>
</template>
