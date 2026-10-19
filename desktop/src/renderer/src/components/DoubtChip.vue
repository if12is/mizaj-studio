<script setup lang="ts">
import { computed } from 'vue'
import { useQualityStore } from '@renderer/stores/quality'
import { doubtView } from '@renderer/editor/doubtChip'

const quality = useQualityStore()
const v = computed(() => doubtView(quality.review))
</script>

<template>
  <span
    v-if="v.kind !== 'hidden'"
    class="flex items-center gap-1"
    data-testid="doubt-chip-wrap"
    :data-kind="v.kind"
  >
    <button
      v-if="v.kind === 'doubt'"
      class="rounded-full border border-mizaj-amber/60 bg-mizaj-amber/15 px-2 py-0.5 text-xs"
      title="بدء مراجعة الكلمات المشكوك فيها (F7)"
      data-testid="doubt-chip"
      @click="quality.reviewControls?.start()"
    >
      {{ v.text }}
    </button>
    <span
      v-else
      class="rounded-full border border-mizaj-emerald/60 bg-mizaj-emerald/15 px-2 py-0.5 text-xs"
      data-testid="doubt-chip"
      data-done="true"
      role="status"
      >{{ v.text }}</span
    >
    <template v-if="v.kind === 'doubt' && quality.review.active">
      <button
        class="rounded border px-1"
        title="الكلمة السابقة (Shift+F7)"
        aria-label="الكلمة السابقة"
        data-testid="doubt-prev"
        @click="quality.reviewControls?.step(-1)"
      >
        ›
      </button>
      <span v-if="v.position" data-testid="doubt-position" aria-live="polite">{{
        v.position
      }}</span>
      <button
        class="rounded border px-1"
        title="الكلمة التالية (F7)"
        aria-label="الكلمة التالية"
        data-testid="doubt-next"
        @click="quality.reviewControls?.step(1)"
      >
        ‹
      </button>
    </template>
  </span>
</template>
