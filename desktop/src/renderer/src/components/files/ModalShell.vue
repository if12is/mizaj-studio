<script setup lang="ts">
import { ref } from 'vue'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'

const props = defineProps<{ title: string; testid: string; wide?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()
const el = ref<HTMLElement | null>(null)
useFocusTrap(el, () => emit('close'))
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="emit('close')"
  >
    <div
      ref="el"
      class="max-h-[90vh] max-w-[95vw] overflow-y-auto rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800"
      :class="props.wide ? 'w-[52rem]' : 'w-[38rem]'"
      role="dialog"
      aria-modal="true"
      :aria-label="props.title"
      :data-testid="props.testid"
    >
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-lg font-bold">{{ props.title }}</h2>
        <button :data-testid="`${props.testid}-close`" aria-label="إغلاق" @click="emit('close')">
          &#10005;
        </button>
      </div>
      <slot />
    </div>
  </div>
</template>
