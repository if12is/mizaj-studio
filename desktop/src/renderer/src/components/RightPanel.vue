<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useReducedMotion } from '@renderer/lib/motion'
import MotionTransition from '@renderer/components/ui/MotionTransition.vue'
import { useEditorStore } from '@renderer/stores/editor'
import { useSettingsStore } from '@renderer/stores/settings'
import { lazyPanel } from '@renderer/lib/lazy'
import {
  PANEL_DEFAULT_H,
  PANEL_DEFAULT_W,
  PANEL_MIN_H,
  PANEL_MIN_W,
  clampSize,
  keyboardSize,
  maxFor,
  parseDock,
  parseSize
} from '@renderer/lib/panelLayout'

// each panel is its own chunk, loaded the first time it is opened (skeleton while loading)
const reduced = useReducedMotion()
const LegalPanel = lazyPanel(() => import('./LegalPanel.vue'))
const SpellingPanel = lazyPanel(() => import('./SpellingPanel.vue'))
const PoetryPanel = lazyPanel(() => import('./PoetryPanel.vue'))
const GeminiPanel = lazyPanel(() => import('./GeminiPanel.vue'))
const EditorQualitySettings = lazyPanel(() => import('./settings/EditorQualitySettings.vue'))

/** The panel is rendered twice (beside the editor / below it); only the chosen dock shows. */
const props = defineProps<{
  openDocument: (id: number) => Promise<void>
  place: 'side' | 'bottom'
}>()
const editor = useEditorStore()
const settings = useSettingsStore()

const dock = computed(() => parseDock(settings.values.panel_dock))
const collapsed = computed(() => settings.values.panel_collapsed === 'true')
const visible = computed(() => !!editor.rightPanel && dock.value === props.place)

const savedSize = computed(() =>
  parseSize(dock.value === 'side' ? settings.values.panel_width : settings.values.panel_height)
)
const live = ref<number | null>(null) // size while dragging / using the keyboard
const aside = ref<HTMLElement | null>(null)

const viewport = (): number => (dock.value === 'side' ? window.innerWidth : window.innerHeight)
const size = computed(() => {
  const v = live.value ?? savedSize.value
  if (v !== null) return clampSize(dock.value, v, viewport())
  return dock.value === 'side'
    ? editor.rightPanel === 'legal' && editor.legalWide
      ? 544
      : PANEL_DEFAULT_W
    : PANEL_DEFAULT_H
})
const COLLAPSED_SIDE = 40
const style = computed(() => {
  if (collapsed.value) return dock.value === 'side' ? { width: `${COLLAPSED_SIDE}px` } : {}
  return dock.value === 'side' ? { width: `${size.value}px` } : { height: `${size.value}px` }
})

const TITLES: Record<string, string> = {
  legal: 'أدوات قانونية',
  poetry: 'الشعر والعروض',
  quality: 'جودة التحرير',
  gemini: 'اسأل عن المستند',
  spelling: 'قائمة الأخطاء الإملائية'
}
const title = computed(() => TITLES[editor.rightPanel ?? 'spelling'] ?? TITLES.spelling)

const key = (): string => (dock.value === 'side' ? 'panel_width' : 'panel_height')
function persist(): void {
  if (live.value === null) return
  const v = clampSize(dock.value, live.value, viewport())
  live.value = null
  void settings.update({ [key()]: String(v) })
}
/** The side panel sits on the physical left in the RTL layout (inner edge = its right edge). */
function onLeft(): boolean {
  const r = aside.value?.getBoundingClientRect()
  return !r || r.left + r.width / 2 < window.innerWidth / 2
}

let moveHandler: ((e: PointerEvent) => void) | null = null
let upHandler: (() => void) | null = null
function stopDrag(): void {
  if (moveHandler) window.removeEventListener('pointermove', moveHandler)
  if (upHandler) {
    window.removeEventListener('pointerup', upHandler)
    window.removeEventListener('pointercancel', upHandler)
  }
  moveHandler = upHandler = null
  document.body.style.userSelect = ''
}
function startDrag(e: PointerEvent): void {
  const r = aside.value?.getBoundingClientRect()
  if (!r) return
  e.preventDefault()
  const side = dock.value === 'side'
  const left = onLeft()
  document.body.style.userSelect = 'none'
  moveHandler = (ev: PointerEvent): void => {
    const raw = side ? (left ? ev.clientX - r.left : r.right - ev.clientX) : r.bottom - ev.clientY
    live.value = clampSize(dock.value, raw, viewport())
  }
  upHandler = (): void => {
    stopDrag()
    persist()
  }
  window.addEventListener('pointermove', moveHandler)
  window.addEventListener('pointerup', upHandler)
  window.addEventListener('pointercancel', upHandler)
}
function onHandleKey(e: KeyboardEvent): void {
  const grow = dock.value === 'bottom' ? 'ArrowUp' : onLeft() ? 'ArrowRight' : 'ArrowLeft'
  const next = keyboardSize(dock.value, size.value, e.key, e.shiftKey, grow, viewport())
  if (next === null) return
  e.preventDefault()
  live.value = next
  void settings.update({ [key()]: String(next) }).then(() => (live.value = null))
}
onBeforeUnmount(stopDrag)

const toggleCollapsed = (): Promise<void> =>
  settings.update({ panel_collapsed: String(!collapsed.value) })
const toggleDock = (): Promise<void> =>
  settings.update({ panel_dock: dock.value === 'side' ? 'bottom' : 'side' })
</script>

<template>
  <MotionTransition name="m-panel">
    <aside
      v-if="visible"
      ref="aside"
      class="relative flex shrink-0 flex-col bg-slate-50 dark:bg-slate-900/60"
      :class="
        dock === 'side'
          ? 'border-r border-slate-200 dark:border-slate-700'
          : 'border-t border-slate-200 dark:border-slate-700'
      "
      :style="style"
      data-testid="right-panel"
      :data-panel="editor.rightPanel"
      :data-dock="dock"
      :data-collapsed="collapsed"
    >
      <div
        v-if="!collapsed"
        role="separator"
        tabindex="0"
        class="panel-resize absolute z-10 hover:bg-mizaj-emerald/40 focus-visible:bg-mizaj-emerald/60"
        :class="
          dock === 'side'
            ? 'inset-y-0 -right-1 w-2 cursor-col-resize'
            : 'inset-x-0 -top-1 h-2 cursor-row-resize'
        "
        :aria-orientation="dock === 'side' ? 'vertical' : 'horizontal'"
        :aria-valuemin="dock === 'side' ? PANEL_MIN_W : PANEL_MIN_H"
        :aria-valuemax="maxFor(dock, viewport())"
        :aria-valuenow="size"
        aria-label="تغيير حجم اللوحة (استخدم الأسهم)"
        data-testid="panel-resize-handle"
        @pointerdown="startDrag"
        @keydown="onHandleKey"
      ></div>
      <div
        class="flex items-center justify-between gap-1 px-3 py-1"
        :class="[collapsed && dock === 'side' ? 'flex-col px-1' : 'border-b dark:border-slate-700']"
      >
        <h2
          class="text-sm font-semibold"
          :class="collapsed && dock === 'side' ? '[writing-mode:vertical-rl]' : ''"
        >
          {{ title }}
        </h2>
        <div class="flex items-center gap-1">
          <button
            :aria-label="dock === 'side' ? 'تثبيت اللوحة في الأسفل' : 'تثبيت اللوحة على الجانب'"
            :title="dock === 'side' ? 'تثبيت في الأسفل' : 'تثبيت على الجانب'"
            data-testid="panel-dock-toggle"
            @click="toggleDock"
          >
            {{ dock === 'side' ? '⬓' : '◧' }}
          </button>
          <button
            :aria-label="collapsed ? 'توسيع اللوحة' : 'طي اللوحة'"
            :aria-expanded="!collapsed"
            data-testid="panel-collapse-toggle"
            @click="toggleCollapsed"
          >
            {{ collapsed ? '▸' : '▾' }}
          </button>
          <button
            aria-label="إغلاق"
            data-testid="right-panel-close"
            @click="editor.rightPanel = null"
          >
            ✕
          </button>
        </div>
      </div>
      <Transition name="m-tab" :mode="reduced ? undefined : 'out-in'" :css="!reduced">
        <div
          :key="editor.rightPanel ?? 'none'"
          v-show="!collapsed"
          class="flex min-h-0 flex-1 flex-col"
        >
          <LegalPanel v-if="editor.rightPanel === 'legal'" :open-document="openDocument" />
          <PoetryPanel v-else-if="editor.rightPanel === 'poetry'" />
          <GeminiPanel v-else-if="editor.rightPanel === 'gemini'" />
          <div v-else-if="editor.rightPanel === 'quality'" class="min-h-0 flex-1 overflow-auto p-3">
            <EditorQualitySettings />
          </div>
          <SpellingPanel v-else />
        </div>
      </Transition>
    </aside>
  </MotionTransition>
</template>
