<script setup lang="ts">
/** Small modal confirmation (opaque panel). Escape / backdrop / «إلغاء» cancel. */
import { ref } from 'vue'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'

defineProps<{ title: string; message: string; confirmLabel?: string }>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
const el = ref<HTMLElement | null>(null)
useFocusTrap(el, () => emit('cancel'))
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    data-testid="confirm-backdrop"
    @click.self="emit('cancel')"
  >
    <div
      ref="el"
      class="w-[26rem] max-w-[95vw] rounded-lg border border-slate-300 bg-white p-4 text-slate-900 shadow-xl dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      data-testid="confirm-dialog"
    >
      <h2 id="confirm-title" class="mb-2 text-lg font-bold">{{ title }}</h2>
      <p id="confirm-message" class="mb-4 text-sm" data-testid="confirm-message">{{ message }}</p>
      <div class="flex justify-end gap-2">
        <button
          class="rounded border px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
          data-testid="confirm-cancel"
          @click="emit('cancel')"
        >
          إلغاء
        </button>
        <button
          class="rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700"
          data-testid="confirm-ok"
          @click="emit('confirm')"
        >
          {{ confirmLabel ?? 'حذف' }}
        </button>
      </div>
    </div>
  </div>
</template>
