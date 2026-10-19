<script setup lang="ts">
/**
 * Global search / command palette (Ctrl+K, Ctrl+Shift+P). Everything it lists comes from
 * `buildEntries`: the command registry, settings sections, projects/documents (backend API via
 * the projects store), recent files and guide topics. Enter runs, Esc closes.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { SETTINGS_SECTION_LABELS } from '@renderer/commands/labels'
import { listCommands } from '@renderer/commands/registry'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'
import { buildEntries, flatten, searchEntries, type PaletteEntry } from '@renderer/search/entries'
import { listGuideTopics } from '@renderer/search/guide'
import { usePaletteStore } from '@renderer/stores/palette'
import { useProjectsStore } from '@renderer/stores/projects'
import { SETTINGS_SECTIONS, useSettingsStore } from '@renderer/stores/settings'
import { useTabsStore } from '@renderer/stores/tabs'

const props = defineProps<{ openDocument: (id: number) => void | Promise<void> }>()

const palette = usePaletteStore()
const projects = useProjectsStore()
const settings = useSettingsStore()
const tabs = useTabsStore()

const el = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const query = ref('')
const selected = ref(0)
useFocusTrap(el, () => palette.hide())

function openProject(projectId: number): void {
  projects.currentProjectId = projectId
  const first = projects.documents[projectId]?.[0]
  if (first) void props.openDocument(first.id)
}

const entries = computed(() =>
  buildEntries({
    commands: listCommands(),
    settingsSections: SETTINGS_SECTIONS.map((id) => ({
      id,
      label: SETTINGS_SECTION_LABELS[id] ?? id
    })),
    projects: projects.projects,
    documents: projects.documents,
    recent: tabs.recent,
    guide: listGuideTopics(),
    openSettings: (s) => settings.openSettings(s as (typeof SETTINGS_SECTIONS)[number]),
    openProject,
    openDocument: (id) => void props.openDocument(id)
  })
)
const groups = computed(() => searchEntries(entries.value, query.value))
const flat = computed<PaletteEntry[]>(() => flatten(groups.value))
const indexOf = (e: PaletteEntry): number => flat.value.indexOf(e)

watch(query, () => (selected.value = 0))
watch(flat, (f) => {
  if (selected.value >= f.length) selected.value = Math.max(0, f.length - 1)
})

function close(): void {
  palette.hide()
}
function runEntry(e: PaletteEntry | undefined): void {
  if (!e) return
  close()
  // after the dialog is gone and focus has been restored, so the command can move focus itself
  setTimeout(() => void e.run(), 0)
}
async function scrollToSelected(): Promise<void> {
  await nextTick()
  listEl.value?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
}
function onKey(e: KeyboardEvent): void {
  const n = flat.value.length
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (n) selected.value = (selected.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
    void scrollToSelected()
  } else if (e.key === 'Home' && e.ctrlKey) {
    selected.value = 0
    void scrollToSelected()
  } else if (e.key === 'End' && e.ctrlKey) {
    selected.value = Math.max(0, n - 1)
    void scrollToSelected()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    runEntry(flat.value[selected.value])
  }
}

onMounted(() => {
  input.value?.focus()
  // fresh project/document lists from the backend (silently ignored when it is unavailable)
  void projects.loadProjects().catch(() => {})
})
</script>

<template>
  <div
    class="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-3 pt-[14vh]"
    data-testid="palette-backdrop"
    @mousedown.self="close"
  >
    <div
      ref="el"
      class="w-[40rem] max-w-full overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-900 shadow-2xl dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="البحث الشامل"
      dir="rtl"
      data-testid="palette"
    >
      <input
        ref="input"
        v-model="query"
        type="text"
        class="w-full border-b border-slate-200 bg-transparent px-4 py-3 text-base outline-none dark:border-slate-700"
        placeholder="ابحث عن أمر أو إعداد أو مشروع أو مستند…"
        role="combobox"
        aria-label="بحث"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="palette-list"
        :aria-activedescendant="flat.length ? `palette-opt-${selected}` : undefined"
        autocomplete="off"
        spellcheck="false"
        data-testid="palette-input"
        @keydown="onKey"
      />
      <div
        id="palette-list"
        ref="listEl"
        class="max-h-[50vh] overflow-auto py-1"
        role="listbox"
        aria-label="النتائج"
        data-testid="palette-list"
      >
        <p
          v-if="!flat.length"
          class="px-4 py-6 text-center text-sm text-slate-500"
          data-testid="palette-empty"
        >
          لا توجد نتائج
        </p>
        <template v-for="g in groups" :key="g.id">
          <div
            class="px-4 pb-1 pt-2 text-xs font-semibold text-slate-500"
            role="presentation"
            :data-testid="`palette-group-${g.id}`"
          >
            {{ g.label }}
          </div>
          <div
            v-for="it in g.items"
            :id="`palette-opt-${indexOf(it)}`"
            :key="it.id"
            role="option"
            class="flex cursor-pointer items-center justify-between gap-3 px-4 py-1.5 text-sm"
            :class="
              indexOf(it) === selected
                ? 'bg-mizaj-emerald/15 dark:bg-mizaj-emerald/25'
                : 'hover:bg-slate-100 dark:hover:bg-slate-700'
            "
            :aria-selected="indexOf(it) === selected"
            data-testid="palette-item"
            :data-entry="it.id"
            @mousemove="selected = indexOf(it)"
            @click="runEntry(it)"
          >
            <span class="min-w-0 truncate">
              {{ it.title }}
              <span v-if="it.subtitle" class="ms-2 text-xs text-slate-500">{{ it.subtitle }}</span>
            </span>
            <kbd
              v-if="it.shortcut"
              class="shrink-0 rounded border border-slate-300 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:border-slate-600 dark:text-slate-300"
              dir="ltr"
              >{{ it.shortcut }}</kbd
            >
          </div>
        </template>
      </div>
      <div
        class="flex gap-4 border-t border-slate-200 px-4 py-1.5 text-xs text-slate-500 dark:border-slate-700"
      >
        <span>↑↓ تنقّل</span>
        <span>Enter تنفيذ</span>
        <span>Esc إغلاق</span>
      </div>
    </div>
  </div>
</template>
