<script setup lang="ts">
// Loading placeholder for lists/panels (async chunks, first fetch). `rows` lines of varying width.
withDefaults(defineProps<{ rows?: number; label?: string }>(), {
  rows: 4,
  label: 'جاري التحميل'
})
const widths = ['92%', '78%', '85%', '64%', '88%', '72%']
</script>

<template>
  <div class="space-y-3 p-3" role="status" :aria-label="label" data-testid="skeleton">
    <div class="m-skeleton h-5 w-2/5" />
    <div
      v-for="i in rows"
      :key="i"
      class="m-skeleton h-4"
      :style="{ width: widths[(i - 1) % widths.length] }"
    />
  </div>
</template>
