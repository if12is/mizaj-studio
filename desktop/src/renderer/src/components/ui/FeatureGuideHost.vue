<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  runToastAction,
  actionToasts,
  dismissActionToast
} from '@renderer/composables/useActionToast'
import { spotlight } from '@renderer/composables/useSpotlight'
import { markFeatureUsed, newFeatures } from '@renderer/composables/useNewFeatures'
import { useUpdateSuggestion } from '@renderer/composables/useUpdateSuggestion'
import { FEATURES, type FeatureId } from '@renderer/features/registry'
import MotionGroup from './MotionGroup.vue'
import SuccessCheck from './SuccessCheck.vue'

// Reusable overlay host: action toasts, spotlight ring + tooltip, «جديد» badges.
// Mounted once in App.vue; features only call announceFeature()/showActionToast()/spotlightElement().
const win = window
useUpdateSuggestion()

interface Badge {
  id: FeatureId
  top: number
  left: number
}
const badges = ref<Badge[]>([])
let poll: ReturnType<typeof setInterval> | null = null

function measure(): void {
  const out: Badge[] = []
  for (const id of newFeatures.value) {
    const el = document.querySelector(FEATURES[id].selector)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    out.push({ id, top: r.top - 6, left: r.left - 4 })
  }
  const same =
    out.length === badges.value.length &&
    out.every(
      (b, i) =>
        b.id === badges.value[i].id &&
        b.top === badges.value[i].top &&
        b.left === badges.value[i].left
    )
  if (!same) badges.value = out
}

/** First use = the user clicks the feature's button (capture, so it also works inside menus). */
function onUse(e: MouseEvent): void {
  const t = e.target as Element | null
  if (!t || !t.closest) return
  for (const id of newFeatures.value) if (t.closest(FEATURES[id].selector)) markFeatureUsed(id)
}

onMounted(() => {
  poll = setInterval(measure, 500)
  document.addEventListener('click', onUse, true)
})
onBeforeUnmount(() => {
  if (poll) clearInterval(poll)
  document.removeEventListener('click', onUse, true)
})
</script>

<template>
  <div>
    <MotionGroup
      tag="div"
      name="m-toast"
      class="fixed bottom-10 end-3 z-50 flex max-w-sm flex-col gap-2"
      role="region"
      aria-label="تنبيهات الميزات"
      data-testid="action-toasts"
    >
      <div
        v-for="t in actionToasts"
        :key="t.id"
        class="rounded px-3 py-2 text-sm text-white shadow"
        :class="t.kind === 'success' ? 'bg-mizaj-emerald' : 'bg-slate-700'"
        role="status"
        :data-testid="t.testid ?? 'action-toast'"
      >
        <div class="flex items-start gap-2">
          <SuccessCheck v-if="t.kind === 'success'" :size="16" />
          <div class="min-w-0 flex-1">
            <p v-if="t.title" class="font-semibold">{{ t.title }}</p>
            <p>{{ t.text }}</p>
          </div>
          <button
            class="px-1 opacity-80 hover:opacity-100"
            aria-label="إغلاق"
            data-testid="action-toast-close"
            @click="dismissActionToast(t.id)"
          >
            ×
          </button>
        </div>
        <div v-if="t.actions.length" class="mt-2 flex gap-2">
          <button
            v-for="a in t.actions"
            :key="a.label"
            class="rounded border border-white/60 px-2 py-0.5 text-xs hover:bg-white/20"
            :class="a.primary ? 'bg-white/25 font-semibold' : ''"
            :data-testid="a.testid"
            @click="runToastAction(t, a)"
          >
            {{ a.label }}
          </button>
        </div>
      </div>
    </MotionGroup>

    <span
      v-for="b in badges"
      :key="b.id"
      class="pointer-events-none fixed z-40 rounded-full bg-mizaj-amber px-1.5 text-[10px] font-bold leading-4 text-white"
      :style="{ top: b.top + 'px', left: b.left + 'px' }"
      :data-testid="`new-badge-${b.id}`"
      >جديد</span
    >

    <template v-if="spotlight">
      <div
        class="spotlight-ring pointer-events-none fixed z-[60] rounded"
        :style="{
          top: spotlight.rect.top - 4 + 'px',
          left: spotlight.rect.left - 4 + 'px',
          width: spotlight.rect.width + 8 + 'px',
          height: spotlight.rect.height + 8 + 'px'
        }"
        data-testid="spotlight-ring"
      />
      <div
        class="pointer-events-none fixed z-[61] max-w-xs rounded bg-slate-900 px-3 py-2 text-xs text-white shadow-lg"
        :style="{
          top:
            (spotlight.rect.top + spotlight.rect.height + 80 > win.innerHeight
              ? Math.max(8, spotlight.rect.top - 64)
              : spotlight.rect.top + spotlight.rect.height + 12) + 'px',
          left: Math.max(8, Math.min(spotlight.rect.left, win.innerWidth - 300)) + 'px'
        }"
        role="tooltip"
        data-testid="spotlight-tip"
      >
        {{ spotlight.text }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.spotlight-ring {
  box-shadow:
    0 0 0 3px #f59e0b,
    0 0 0 9999px rgb(0 0 0 / 0.35);
  animation: spotlight-pulse 1s ease-in-out infinite;
}
@keyframes spotlight-pulse {
  50% {
    box-shadow:
      0 0 0 6px #f59e0b,
      0 0 0 9999px rgb(0 0 0 / 0.35);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spotlight-ring {
    animation: none;
  }
}
</style>
