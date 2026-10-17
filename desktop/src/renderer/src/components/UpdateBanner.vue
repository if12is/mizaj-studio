<script setup lang="ts">
import { computed } from 'vue'
import { useUpdaterStore } from '@renderer/stores/updater'

const updater = useUpdaterStore()
const s = computed(() => updater.status)
const visible = computed(
  () =>
    (s.value.state === 'available' && !updater.dismissed) ||
    s.value.state === 'downloading' ||
    s.value.state === 'downloaded'
)
</script>

<template>
  <div
    v-if="visible"
    class="flex items-center gap-3 bg-mizaj-emerald/15 px-3 py-1 text-xs"
    data-testid="update-banner"
    :data-state="s.state"
  >
    <template v-if="s.state === 'available'">
      <span data-testid="update-text">يتوفر إصدار جديد {{ s.version }}</span>
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
    </template>
    <template v-else-if="s.state === 'downloading'">
      <span>جاري تنزيل الإصدار {{ s.version }}</span>
      <div class="h-2 flex-1 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
        <div
          class="h-full bg-mizaj-emerald transition-all"
          :style="{ width: (s.percent ?? 0) + '%' }"
          data-testid="update-progress-fill"
        />
      </div>
      <span data-testid="update-percent">{{ s.percent ?? 0 }}%</span>
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
</template>
