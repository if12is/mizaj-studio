<script setup lang="ts">
import { computed, watch } from 'vue'
import { useEditorStore } from '@renderer/stores/editor'

defineEmits<{ (e: 'pause'): void; (e: 'resume'): void; (e: 'cancel'): void }>()
const editor = useEditorStore()
// screen-reader announcements: state changes and every 25 %, not every percent
let lastBucket = -1
watch(
  () => editor.runState,
  (s) => {
    if (s === 'running') {
      lastBucket = -1
      editor.announce('بدأ التشكيل')
    } else if (s === 'paused') editor.announce('تم إيقاف التشكيل مؤقتاً')
    else if (s === 'done') editor.announce('اكتمل التشكيل')
  }
)
watch(
  () => editor.progress,
  (p) => {
    const b = Math.floor(p / 25)
    if (editor.runState === 'running' && b > lastBucket && b > 0 && b < 4) {
      lastBucket = b
      editor.announce(`التشكيل ${b * 25}٪`)
    }
  }
)
const label = computed(() =>
  editor.runState === 'waiting'
    ? 'المحرك قيد التحميل... إعادة المحاولة'
    : editor.runState === 'paused'
      ? 'متوقف مؤقتاً'
      : editor.runState === 'done'
        ? 'اكتمل التشكيل'
        : 'جاري التشكيل'
)
</script>

<template>
  <div
    v-if="editor.runState !== 'idle'"
    class="flex items-center gap-3 border-b border-slate-200 px-3 py-1 text-xs dark:border-slate-700"
    role="progressbar"
    aria-label="تقدم التشكيل"
    :aria-valuenow="editor.progress"
    aria-valuemin="0"
    aria-valuemax="100"
    data-testid="progress-bar"
    :data-state="editor.runState"
  >
    <span>{{ label }}</span>
    <div class="h-2 flex-1 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
      <div
        class="h-full bg-mizaj-emerald transition-all"
        :style="{ width: editor.progress + '%' }"
        data-testid="progress-fill"
      />
    </div>
    <span data-testid="progress-percent">{{ editor.progress }}%</span>
    <span data-testid="progress-wps">{{ Math.round(editor.wps) }} كلمة/ث</span>
    <button
      v-if="editor.runState === 'running' || editor.runState === 'waiting'"
      class="rounded border px-2 py-0.5"
      data-testid="progress-pause"
      @click="$emit('pause')"
    >
      إيقاف مؤقت
    </button>
    <button
      v-else-if="editor.runState === 'paused'"
      class="rounded bg-mizaj-emerald px-2 py-0.5 text-white"
      data-testid="progress-resume"
      @click="$emit('resume')"
    >
      استئناف
    </button>
    <button
      v-if="editor.runState !== 'done'"
      class="rounded border px-2 py-0.5"
      data-testid="progress-cancel"
      @click="$emit('cancel')"
    >
      إلغاء
    </button>
  </div>
</template>
