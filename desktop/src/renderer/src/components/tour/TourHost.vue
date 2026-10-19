<script setup lang="ts">
/**
 * First-run guided tour: five short steps, each pointing at the real button with the same
 * spotlight ring as «أرني». «التالي / السابق / تخطي الجولة», Esc skips, RTL. Shown once.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FEATURES, type FeatureInfo } from '@renderer/features/registry'
import { hideSpotlight, spotlight, spotlightElement } from '@renderer/composables/useSpotlight'
import { toArabicIndic } from '@renderer/lib/arabicDigits'
import { useExtrasStore } from '@renderer/stores/extras'
import { markTourDone } from '@renderer/tour/autostart'
import { TOUR_STEPS } from '@renderer/tour/steps'

const extras = useExtrasStore()
const index = ref(0)
const card = ref<HTMLElement | null>(null)
const next = ref<HTMLButtonElement | null>(null)
const step = computed(() => TOUR_STEPS[index.value])
const last = computed(() => index.value === TOUR_STEPS.length - 1)
const HOUR = 3_600_000
let previous: HTMLElement | null = null

async function show(): Promise<void> {
  const f: FeatureInfo | null = step.value.feature ? FEATURES[step.value.feature] : null
  hideSpotlight()
  if (f) await spotlightElement({ selector: f.selector, reveal: f.reveal, text: '', ms: HOUR })
  await nextTick()
  next.value?.focus()
}
function finish(): void {
  hideSpotlight()
  markTourDone()
  extras.tourActive = false
}
function go(d: 1 | -1): void {
  if (d === 1 && last.value) return finish()
  index.value = Math.min(TOUR_STEPS.length - 1, Math.max(0, index.value + d))
}
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  finish()
}

onMounted(() => {
  previous = document.activeElement as HTMLElement | null
  window.addEventListener('keydown', onKey, true)
  void show()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  hideSpotlight()
  previous?.focus?.()
})
watch(index, () => void show())

const W = 352
const pos = computed(() => {
  const r = spotlight.value?.rect
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!r) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  const left = Math.max(12, Math.min(r.left + r.width / 2 - W / 2, vw - W - 12))
  if (r.top + r.height + 14 + 230 < vh)
    return { top: `${r.top + r.height + 14}px`, left: `${left}px` }
  return { bottom: `${vh - r.top + 14}px`, left: `${left}px` }
})

const btn =
  'rounded-md border px-3 py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-mizaj-emerald'
</script>

<template>
  <div
    ref="card"
    class="fixed z-[62] rounded-lg border border-slate-300 bg-white p-4 text-slate-900 shadow-2xl dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
    :style="{ width: W + 'px', maxWidth: 'calc(100vw - 24px)', ...pos }"
    role="dialog"
    aria-modal="false"
    aria-labelledby="tour-title"
    dir="rtl"
    data-testid="tour-card"
    :data-step="step.id"
  >
    <p class="text-xs text-slate-600 dark:text-slate-300" data-testid="tour-progress">
      الخطوة {{ toArabicIndic(index + 1) }} من {{ toArabicIndic(TOUR_STEPS.length) }}
    </p>
    <h2 id="tour-title" class="mt-1 text-base font-bold" data-testid="tour-title">
      {{ step.title }}
    </h2>
    <p class="mt-1 text-sm leading-relaxed" data-testid="tour-text">{{ step.text }}</p>
    <kbd
      v-if="step.kbd"
      class="mt-2 inline-block rounded border border-slate-300 px-1.5 py-0.5 font-mono text-xs dark:border-slate-500"
      dir="ltr"
      >{{ step.kbd }}</kbd
    >
    <div class="mt-4 flex items-center gap-2">
      <button
        class="rounded px-2 py-1.5 text-sm text-slate-700 underline hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mizaj-emerald dark:text-slate-300 dark:hover:text-white"
        data-testid="tour-skip"
        @click="finish"
      >
        تخطي الجولة
      </button>
      <span class="flex-1" />
      <button
        :class="[
          btn,
          'border-slate-300 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-500 dark:hover:bg-slate-700'
        ]"
        :disabled="index === 0"
        data-testid="tour-prev"
        @click="go(-1)"
      >
        السابق
      </button>
      <button
        ref="next"
        :class="[btn, 'border-emerald-800 bg-emerald-700 text-white hover:bg-emerald-800']"
        data-testid="tour-next"
        @click="go(1)"
      >
        {{ last ? 'إنهاء' : 'التالي' }}
      </button>
    </div>
  </div>
</template>
