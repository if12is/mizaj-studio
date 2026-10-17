<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '@renderer/stores/editor'
import { useSidecarStore } from '@renderer/stores/sidecar'
import { engineWarmupText } from '@renderer/stores/engines'

const editor = useEditorStore()
const sidecar = useSidecarStore()

const sidecarText = computed(() => {
  const s = sidecar.status
  switch (s.state) {
    case 'ready':
      return 'المحرك: جاهز'
    case 'starting':
      return 'المحرك: جاري التشغيل...'
    case 'restarting':
      return `المحرك: إعادة تشغيل (محاولة ${s.retry}/3)`
    case 'crashed':
      return 'المحرك: متوقف بسبب خطأ'
    default:
      return 'المحرك: متوقف'
  }
})
const dot = computed(
  () =>
    ({
      ready: 'bg-mizaj-emerald',
      starting: 'bg-mizaj-amber',
      restarting: 'bg-mizaj-amber',
      crashed: 'bg-red-500',
      stopped: 'bg-slate-500'
    })[sidecar.status.state]
)
const warmup = computed(() => engineWarmupText(sidecar.engines))
const saveText = computed(
  () => ({ saved: 'محفوظ', saving: 'جاري الحفظ', unsaved: 'غير محفوظ' })[editor.saveState]
)
</script>

<template>
  <footer
    class="flex h-7 shrink-0 items-center justify-between bg-slate-100 px-3 text-xs dark:bg-slate-900"
    data-testid="statusbar"
  >
    <div
      class="flex items-center gap-2"
      data-testid="status-sidecar"
      :data-state="sidecar.status.state"
    >
      <span class="inline-block h-2 w-2 rounded-full" :class="dot" />
      <span>{{ sidecarText }}</span>
      <span
        v-if="warmup && sidecar.status.state === 'ready'"
        class="text-mizaj-amber"
        data-testid="status-engines"
        :data-accurate="sidecar.engines?.accurate"
        :data-fast="sidecar.engines?.fast"
        >· {{ warmup }}</span
      >
    </div>
    <div class="flex items-center gap-4">
      <span data-testid="status-words">الكلمات: {{ editor.wordCount }}</span>
      <span data-testid="status-line">السطر: {{ editor.cursorLine }}</span>
      <span data-testid="status-save" :data-state="editor.saveState">{{ saveText }}</span>
    </div>
  </footer>
</template>
