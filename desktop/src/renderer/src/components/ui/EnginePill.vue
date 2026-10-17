<script setup lang="ts">
import MotionTransition from '@renderer/components/ui/MotionTransition.vue'
import { computed } from 'vue'
import { useSidecarStore } from '@renderer/stores/sidecar'
import BrandMark from './BrandMark.vue'

// Engine-starting state: shown over the editor (non-blocking) while the sidecar is not ready.
const sidecar = useSidecarStore()
const visible = computed(() => sidecar.status.state !== 'ready')
const text = computed(() =>
  sidecar.status.state === 'crashed'
    ? 'توقف المحرك'
    : sidecar.status.state === 'stopped'
      ? 'المحرك متوقف'
      : 'المحرك قيد التشغيل...'
)
</script>

<template>
  <MotionTransition name="m-fade">
    <div v-if="visible" class="m-engine-pill" data-testid="engine-pill">
      <BrandMark :size="20" :animated="false" :breathe="sidecar.status.state !== 'crashed'" />
      <span>{{ text }}</span>
    </div>
  </MotionTransition>
</template>
