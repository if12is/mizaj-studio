<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { retryText } from '@renderer/lib/updateText'
import MotionTransition from './ui/MotionTransition.vue'
import { useUpdaterStore } from '@renderer/stores/updater'

const updater = useUpdaterStore()
const showNotes = ref(false)
const s = computed(() => updater.status)
const visible = computed(
  () =>
    (s.value.state === 'available' && !updater.dismissed) ||
    s.value.state === 'downloading' ||
    s.value.state === 'downloaded' ||
    s.value.state === 'retrying'
)

// live countdown while a retry is scheduled
const now = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
watch(
  () => s.value.state,
  (st) => {
    if (tick) clearInterval(tick)
    tick = st === 'retrying' ? setInterval(() => (now.value = Date.now()), 1000) : null
    now.value = Date.now()
  },
  { immediate: true }
)
onBeforeUnmount(() => tick && clearInterval(tick))
</script>

<template>
  <MotionTransition name="m-fade">
    <div
      v-if="visible"
      class="flex flex-wrap items-center gap-3 px-3 py-1 text-xs"
      :class="s.state === 'retrying' ? 'bg-mizaj-amber/15' : 'bg-mizaj-emerald/15'"
      data-testid="update-banner"
      :data-state="s.state"
    >
      <template v-if="s.state === 'available'">
        <span data-testid="update-text">يتوفر إصدار جديد {{ s.version }}</span>
        <button
          v-if="s.notes"
          class="underline"
          :aria-expanded="showNotes"
          data-testid="update-whatsnew"
          @click="showNotes = !showNotes"
        >
          ما الجديد؟
        </button>
        <button
          class="rounded bg-mizaj-emerald px-2 py-0.5 text-white"
          data-testid="update-download"
          @click="updater.download()"
        >
          تنزيل
        </button>
        <button
          class="rounded border px-2 py-0.5"
          data-testid="update-dismiss"
          @click="updater.dismissed = true"
        >
          لاحقاً
        </button>
        <p
          v-if="showNotes && s.notes"
          class="max-h-24 basis-full overflow-auto whitespace-pre-line text-slate-700 dark:text-slate-200"
          data-testid="update-notes"
        >
          {{ s.notes }}
        </p>
      </template>
      <template v-else-if="s.state === 'downloading'">
        <span>جاري تنزيل الإصدار {{ s.version }}</span>
        <div class="h-2 flex-1 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
          <div
            class="m-progress-fill h-full bg-mizaj-emerald"
            :style="{ transform: `scaleX(${(s.percent ?? 0) / 100})` }"
            data-testid="update-progress-fill"
          />
        </div>
        <span data-testid="update-percent">{{ s.percent ?? 0 }}%</span>
      </template>
      <template v-else-if="s.state === 'retrying'">
        <span data-testid="update-retry-text" role="status">{{ retryText(s, now) }}</span>
      </template>
      <template v-else>
        <span>تم تنزيل الإصدار {{ s.version }}</span>
        <button
          class="rounded bg-mizaj-emerald px-2 py-0.5 text-white"
          data-testid="update-install"
          @click="updater.install()"
        >
          إعادة التشغيل والتثبيت
        </button>
      </template>
    </div>
  </MotionTransition>
</template>
