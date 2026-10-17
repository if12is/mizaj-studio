<script setup lang="ts">
import { computed } from 'vue'
import { useSidecarStore } from '@renderer/stores/sidecar'
import BrandMark from './BrandMark.vue'

const sidecar = useSidecarStore()
const text = computed(() => {
  switch (sidecar.status.state) {
    case 'ready':
      return 'جاهز'
    case 'restarting':
      return 'إعادة تشغيل المحرك...'
    case 'crashed':
      return 'توقف المحرك بسبب خطأ'
    case 'stopped':
      return 'المحرك متوقف'
    default:
      return 'جاري تشغيل المحرك...'
  }
})
</script>

<template>
  <div class="m-splash" role="status" aria-live="polite" data-testid="splash">
    <BrandMark :size="200" />
    <div class="m-splash-name" lang="ar">مِزَاج</div>
    <div class="m-splash-text" data-testid="splash-text">{{ text }}</div>
  </div>
</template>
