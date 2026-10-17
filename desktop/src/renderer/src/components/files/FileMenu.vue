<script setup lang="ts">
import MotionTransition from '@renderer/components/ui/MotionTransition.vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { EXPORT_FORMATS } from '@renderer/files/formats'
import { useFileStore } from '@renderer/stores/fileio'
import { useProjectsStore } from '@renderer/stores/projects'

const files = useFileStore()
const projects = useProjectsStore()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

function close(): void {
  open.value = false
}
function onDocClick(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) {
    close()
    root.value?.querySelector<HTMLElement>('[data-testid=file-menu]')?.focus()
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey)
})

const item =
  'block w-full px-3 py-1.5 text-start text-sm hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-700'
</script>

<template>
  <div ref="root" class="relative">
    <button
      class="rounded px-2 py-1 text-sm hover:bg-slate-200 dark:hover:bg-slate-700"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-testid="file-menu"
      @click="open = !open"
    >
      ملف
    </button>
    <MotionTransition name="m-menu">
      <div
        v-if="open"
        class="absolute start-0 top-full z-40 mt-1 w-60 rounded border bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
        role="menu"
        data-testid="file-menu-list"
      >
        <button
          :class="item"
          role="menuitem"
          data-testid="file-import"
          @click="close(), files.importFile()"
        >
          استيراد ملف…
        </button>
        <div class="my-1 border-t dark:border-slate-600" role="separator" />
        <p class="px-3 py-0.5 text-xs text-slate-500">تصدير المستند الحالي كـ…</p>
        <button
          v-for="f in EXPORT_FORMATS"
          :key="f.id"
          :class="item"
          role="menuitem"
          :disabled="!projects.currentDocument || files.busy"
          :data-testid="`file-export-${f.id}`"
          @click="close(), files.exportAs(f.id)"
        >
          {{ f.label }}
        </button>
        <div class="my-1 border-t dark:border-slate-600" role="separator" />
        <button
          :class="item"
          role="menuitem"
          data-testid="file-batch"
          @click="close(), (files.batchOpen = true)"
        >
          معالجة مجلد…
        </button>
      </div>
    </MotionTransition>
  </div>
</template>
