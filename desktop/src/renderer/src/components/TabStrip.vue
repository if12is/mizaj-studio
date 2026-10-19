<script setup lang="ts">
/** Document tab strip (under the titlebar). State lives in the tabs store; App.vue does the work. */
import { computed, nextTick, ref, watch } from 'vue'
import TabCloseDialog from './TabCloseDialog.vue'
import { useTabsStore } from '@renderer/stores/tabs'

const emit = defineEmits<{
  (e: 'activate', id: string): void
  (e: 'close', id: string): void
  (e: 'new'): void
  (e: 'resolve-close', choice: 'save' | 'discard' | 'cancel'): void
}>()
const tabs = useTabsStore()
const strip = ref<HTMLElement | null>(null)
const dragFrom = ref<number | null>(null)
const dragOver = ref<number | null>(null)
const prompting = computed(() => tabs.tabs.find((t) => t.id === tabs.closePrompt) ?? null)

watch(
  () => tabs.activeId,
  async () => {
    await nextTick()
    strip.value?.querySelector('[aria-selected=true]')?.scrollIntoView?.({ inline: 'nearest' })
  }
)

function onAux(e: MouseEvent, id: string): void {
  if (e.button === 1) {
    e.preventDefault()
    emit('close', id)
  }
}
function onDrop(i: number): void {
  if (dragFrom.value !== null) tabs.move(dragFrom.value, i)
  dragFrom.value = dragOver.value = null
}
</script>

<template>
  <div
    class="flex items-stretch border-b border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-900"
    data-testid="tab-strip"
  >
    <div
      ref="strip"
      class="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      role="group"
      aria-label="المستندات المفتوحة"
    >
      <div
        v-for="(t, i) in tabs.tabs"
        :key="t.id"
        class="group flex max-w-[14rem] min-w-[7rem] cursor-pointer select-none items-center gap-1 border-e border-slate-200 px-2 py-1 text-sm dark:border-slate-700"
        :class="[
          t.id === tabs.activeId
            ? 'bg-white font-semibold dark:bg-mizaj-slate'
            : 'text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800',
          dragOver === i && dragFrom !== i ? 'outline outline-1 outline-mizaj-emerald' : ''
        ]"
        draggable="true"
        data-testid="tab"
        :data-tab-id="t.id"
        :data-active="t.id === tabs.activeId"
        @click="emit('activate', t.id)"
        @auxclick="onAux($event, t.id)"
        @mousedown.middle.prevent
        @dragstart="(dragFrom = i), $event.dataTransfer?.setData('text/plain', t.id)"
        @dragover.prevent="dragOver = i"
        @dragleave="dragOver = null"
        @drop.prevent="onDrop(i)"
        @dragend="dragFrom = dragOver = null"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1 text-start"
          :aria-current="t.id === tabs.activeId ? 'true' : undefined"
          :title="t.title"
        >
          <span
            v-if="t.dirty"
            class="h-2 w-2 shrink-0 rounded-full bg-mizaj-amber"
            role="img"
            aria-label="تغييرات غير محفوظة"
            data-testid="tab-dirty"
          />
          <span class="min-w-0 flex-1 truncate" data-testid="tab-title">{{ t.title }}</span>
        </button>
        <button
          type="button"
          class="shrink-0 rounded px-1 text-xs opacity-60 hover:bg-slate-300 hover:opacity-100 group-hover:opacity-100 dark:hover:bg-slate-600"
          :aria-label="`إغلاق ${t.title}`"
          tabindex="-1"
          data-testid="tab-close"
          @click.stop="emit('close', t.id)"
        >
          ✕
        </button>
      </div>
    </div>
    <button
      type="button"
      class="shrink-0 px-3 text-lg leading-none text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
      aria-label="تبويب جديد (Ctrl+T)"
      title="تبويب جديد (Ctrl+T)"
      data-testid="tab-new"
      @click="emit('new')"
    >
      +
    </button>
  </div>
  <TabCloseDialog
    v-if="prompting"
    :title="prompting.title"
    @resolve="(c) => emit('resolve-close', c)"
  />
</template>
