<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { notify } from '@renderer/api/toast'
import AppIcon, { type IconName } from './AppIcon.vue'

/**
 * A toolbar button with an unmistakable on/off state:
 *  - on: filled tint + check mark (toggle) or x (open panel), aria-pressed / aria-expanded
 *  - tooltip = name + shortcut
 *  - a short toast says what the click did; the button flashes when its state changes
 *  - when it cannot run, it stays focusable (aria-disabled) and the click explains why
 */
const props = defineProps<{
  on?: boolean
  /** short name used in the tooltip and toast */
  name: string
  icon?: IconName
  shortcut?: string
  /** a panel: reports aria-expanded and shows a x while open */
  panel?: boolean
  /** a spinner is shown while the action runs */
  busy?: boolean
  /** disable the "Name: on/off" toast (e.g. the action toasts by itself) */
  quiet?: boolean
  /** a one-shot action (not a toggle): no pressed state; the click toasts `message` */
  action?: boolean
  message?: string
  /** set while the action cannot run: the click shows this text instead of doing nothing */
  disabledReason?: string
}>()
const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>()

const blocked = computed(() => !!props.disabledReason)
const tip = computed(() => {
  if (blocked.value) return `${props.name} — غير متاح: ${props.disabledReason}`
  const state = props.panel
    ? props.on
      ? 'مفتوحة، اضغط للإغلاق'
      : 'مغلقة، اضغط للفتح'
    : props.on
      ? 'مفعّل، اضغط للإيقاف'
      : 'متوقف، اضغط للتفعيل'
  return `${props.name} — ${state}${props.shortcut ? ` (${props.shortcut})` : ''}`
})

const flash = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.on,
  () => {
    if (props.action) return
    flash.value = true
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => (flash.value = false), 700)
  }
)

function onClick(ev: MouseEvent): void {
  if (blocked.value) {
    notify(`${props.name}: ${props.disabledReason}`, { kind: 'info', ms: 3500 })
    return
  }
  if (props.action) {
    if (!props.quiet) notify(props.message ?? props.name, { kind: 'info', ms: 1800 })
  } else if (!props.quiet) {
    const next = !props.on
    notify(
      props.panel
        ? `${next ? 'فُتحت' : 'أُغلقت'} لوحة «${props.name}»`
        : `${props.name}: ${next ? 'مفعّل' : 'متوقف'}`,
      { kind: 'info', ms: 1600 }
    )
  }
  emit('click', ev)
}
</script>

<template>
  <button
    type="button"
    class="inline-flex items-center gap-1 rounded border px-2 py-1 transition-colors"
    :class="[
      on && !action
        ? 'border-mizaj-emerald bg-mizaj-emerald/20 font-semibold text-emerald-700 hover:bg-mizaj-emerald/30 dark:text-emerald-300'
        : 'border-slate-300 hover:bg-slate-200 dark:border-slate-600 dark:hover:bg-slate-700',
      blocked ? 'cursor-not-allowed opacity-50' : '',
      flash ? 'm-flash' : ''
    ]"
    :title="tip"
    :aria-pressed="panel || action ? undefined : on"
    :aria-expanded="panel ? on : undefined"
    :aria-disabled="blocked || undefined"
    :data-on="on"
    @click="onClick"
  >
    <span
      v-if="busy"
      class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
      data-testid="toggle-spinner"
    />
    <AppIcon v-else-if="icon" :name="icon" :size="14" />
    <slot />
    <AppIcon v-if="on && !panel && !action" name="check" :size="12" />
    <AppIcon v-if="on && panel" name="close" :size="10" class="opacity-70" />
  </button>
</template>
