<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '@renderer/stores/editor'
import { useQualityStore } from '@renderer/stores/quality'

const emit = defineEmits<{
  (e: 'step', dir: 1 | -1): void
  (e: 'keep'): void
  (e: 'inspect'): void
}>()
const quality = useQualityStore()
const editor = useEditorStore()
const done = computed(() => quality.review.total > 0 && quality.review.remaining === 0)
function exit(): void {
  quality.review.active = false
  editor.announce('تم إنهاء وضع المراجعة')
}
</script>

<template>
  <div
    v-if="quality.review.active"
    class="flex flex-wrap items-center gap-2 border-b border-mizaj-amber/40 bg-mizaj-amber/10 px-3 py-1 text-xs"
    role="region"
    aria-label="وضع المراجعة"
    data-testid="review-bar"
  >
    <b>وضع المراجعة</b>
    <span data-testid="review-progress" aria-live="polite">
      {{ quality.review.reviewed }} / {{ quality.review.total }} تمت مراجعتها
      <template v-if="done"> — اكتملت المراجعة</template>
    </span>
    <button
      class="rounded border px-2 py-0.5"
      title="Shift+F7"
      data-testid="review-prev"
      @click="emit('step', -1)"
    >
      السابقة
    </button>
    <button
      class="rounded border px-2 py-0.5"
      title="F7"
      data-testid="review-next"
      @click="emit('step', 1)"
    >
      التالية
    </button>
    <button
      class="rounded bg-mizaj-emerald px-2 py-0.5 text-white"
      title="Ctrl+Enter"
      data-testid="review-keep"
      @click="emit('keep')"
    >
      أبقِ التشكيل
    </button>
    <button
      class="rounded border px-2 py-0.5"
      title="Ctrl+."
      data-testid="review-inspect"
      @click="emit('inspect')"
    >
      تعديل الكلمة
    </button>
    <button class="rounded border px-2 py-0.5" title="Esc" data-testid="review-exit" @click="exit">
      خروج
    </button>
  </div>
</template>
