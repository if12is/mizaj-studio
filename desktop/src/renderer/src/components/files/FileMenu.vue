<script setup lang="ts">
import MotionTransition from '@renderer/components/ui/MotionTransition.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { EXPORT_FORMATS, type ExportId } from '@renderer/files/formats'
import { useFileStore } from '@renderer/stores/fileio'
import { useProjectsStore } from '@renderer/stores/projects'
import { notify } from '@renderer/api/toast'
import AppIcon, { type IconName } from '@renderer/components/ui/AppIcon.vue'

const files = useFileStore()
const projects = useProjectsStore()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

const iconFor = (id: string): IconName =>
  id === 'txt' ? 'normalize' : id === 'md' ? 'poetry' : id === 'srt' ? 'read' : 'page'

function close(): void {
  open.value = false
}
function focusButton(): void {
  root.value?.querySelector<HTMLElement>('[data-testid=file-menu]')?.focus()
}
function onDocClick(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close()
}
function items(): HTMLElement[] {
  return [...(root.value?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation() // the menu is the top layer: Esc must not also close a panel behind it
    close()
    focusButton()
    return
  }
  if (
    open.value &&
    (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
    root.value?.contains(e.target as Node)
  ) {
    e.preventDefault()
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLElement)
    const n = e.key === 'ArrowDown' ? i + 1 : i - 1
    list[(n + list.length) % list.length]?.focus()
    return
  }
  // accelerators shown in the menu
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase()
    if (k === 'o') {
      e.preventDefault()
      runImport()
    } else if (k === 'e') {
      e.preventDefault()
      runExport('docx')
    }
  }
}
onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey, true)
})

function runImport(): void {
  close()
  notify('جارٍ فتح نافذة الاستيراد…', { kind: 'info', ms: 1500 })
  void files.importFile()
}
const exportBlocked = computed(() => !projects.currentDocument || files.busy)
function runExport(id: ExportId): void {
  if (exportBlocked.value) {
    // never a silent no-op: say why the item cannot run
    notify(files.busy ? 'عملية أخرى جارية الآن، انتظر حتى تنتهي.' : 'افتح مستنداً أولاً لتصديره.', {
      kind: 'info',
      ms: 3000
    })
    return
  }
  close()
  const label = EXPORT_FORMATS.find((f) => f.id === id)?.label ?? id
  notify(`جارٍ التصدير: ${label}`, { kind: 'info', ms: 2000 })
  void files.exportAs(id)
}
function runBatch(): void {
  close()
  files.batchOpen = true
}

const item =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-start text-sm text-slate-800 hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus-visible:bg-slate-700'
const kbd =
  'ms-auto rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500 dark:bg-slate-900 dark:text-slate-400'
const heading = 'px-2.5 pb-1 pt-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400'
</script>

<template>
  <div ref="root" class="relative">
    <button
      class="flex items-center gap-1.5 rounded-md border px-3 py-1 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-mizaj-emerald"
      :class="
        open
          ? 'border-mizaj-emerald bg-mizaj-emerald/15 text-mizaj-emerald'
          : 'border-slate-300 bg-slate-100 hover:border-mizaj-emerald/60 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-700/60 dark:hover:bg-slate-700'
      "
      aria-haspopup="menu"
      :aria-expanded="open"
      title="قائمة الملف"
      data-testid="file-menu"
      @click="open = !open"
    >
      ملف
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        aria-hidden="true"
        :class="open ? 'rotate-180' : ''"
      >
        <path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none" />
      </svg>
    </button>
    <MotionTransition name="m-menu">
      <div
        v-if="open"
        class="absolute start-0 top-full z-40 mt-1.5 w-72 rounded-lg border border-slate-200 bg-white p-1.5 shadow-xl dark:border-slate-600 dark:bg-slate-800"
        role="menu"
        aria-label="ملف"
        data-testid="file-menu-list"
      >
        <p :class="heading">فتح</p>
        <button :class="item" role="menuitem" data-testid="file-import" @click="runImport">
          <AppIcon name="import" class="text-mizaj-emerald" />
          استيراد ملف…
          <kbd :class="kbd" dir="ltr">Ctrl+O</kbd>
        </button>
        <button :class="item" role="menuitem" data-testid="file-batch" @click="runBatch">
          <AppIcon name="folder" class="text-mizaj-emerald" />
          معالجة مجلد كامل…
        </button>
        <div class="my-1.5 border-t border-slate-200 dark:border-slate-600" role="separator" />
        <p :class="heading">تصدير المستند الحالي كـ</p>
        <button
          v-for="f in EXPORT_FORMATS"
          :key="f.id"
          :class="item"
          role="menuitem"
          :aria-disabled="exportBlocked || undefined"
          :data-testid="`file-export-${f.id}`"
          @click="runExport(f.id)"
        >
          <AppIcon :name="iconFor(f.id)" class="text-slate-500 dark:text-slate-400" />
          {{ f.label }}
          <kbd v-if="f.id === 'docx'" :class="kbd" dir="ltr">Ctrl+E</kbd>
        </button>
      </div>
    </MotionTransition>
  </div>
</template>
