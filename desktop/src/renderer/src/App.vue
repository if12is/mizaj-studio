<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TitleBar from './components/TitleBar.vue'
import Sidebar from './components/Sidebar.vue'
import EditorPane from './components/EditorPane.vue'
import StatusBar from './components/StatusBar.vue'
import SettingsModal from './components/SettingsModal.vue'
import { toasts } from './api/toast'
import { createAutosave } from './composables/autosave'
import { useEditorStore } from './stores/editor'
import { useProjectsStore } from './stores/projects'
import { useSettingsStore } from './stores/settings'
import { useSidecarStore } from './stores/sidecar'

const sidecar = useSidecarStore()
const projects = useProjectsStore()
const settings = useSettingsStore()
const editor = useEditorStore()
const showSettings = ref(false)
const pane = ref<InstanceType<typeof EditorPane> | null>(null)

const autosave = createAutosave({
  delayMs: 5000,
  getText: () => editor.accessor?.getText() ?? '',
  save: (id, text) => projects.saveContent(id, text, !!editor.diacritizedDocs[id]),
  onState: (s) => (editor.saveState = s)
})

let switchSeq = 0
async function selectDocument(id: number): Promise<void> {
  const token = ++switchSeq
  await autosave.flush() // save the outgoing document first
  const d = await projects.fetchDocument(id)
  if (token !== switchSeq) return // a newer selection superseded this one
  // Flush again: edits typed while the fetch was in flight still belong to the old document.
  await autosave.flush()
  if (token !== switchSeq) return
  // From here on everything is synchronous: swap text, current doc and autosave target together.
  projects.setCurrentDocument(d)
  pane.value?.setText(d.raw_content)
  autosave.setDocument(id)
  if (d.diacritized_content) editor.diacritizedDocs = { ...editor.diacritizedDocs, [id]: true }
}

const flushNow = (): void => void autosave.flush()
let offFlush: (() => void) | undefined

async function bootstrap(): Promise<void> {
  try {
    await settings.load()
    await projects.loadProjects()
  } catch {
    /* error toast shown by api client */
  }
}

onMounted(async () => {
  settings.applyToDom()
  window.addEventListener('blur', flushNow)
  window.addEventListener('beforeunload', flushNow)
  offFlush = window.mizajAPI?.onBeforeQuitFlush(() => autosave.flush())
  await sidecar.init()
  if (sidecar.isReady) void bootstrap()
})
watch(
  () => sidecar.isReady,
  (ready, was) => {
    if (ready && !was) void bootstrap()
  }
)
onBeforeUnmount(() => {
  window.removeEventListener('blur', flushNow)
  window.removeEventListener('beforeunload', flushNow)
  offFlush?.()
  autosave.dispose()
})
</script>

<template>
  <div
    class="flex h-full flex-col bg-white text-slate-900 dark:bg-mizaj-slate dark:text-slate-100"
    data-testid="app-root"
  >
    <TitleBar />
    <div class="flex min-h-0 flex-1">
      <Sidebar @select-document="selectDocument" />
      <main class="flex min-w-0 flex-1 flex-col">
        <div
          class="flex items-center justify-between border-b border-slate-200 px-3 py-1 dark:border-slate-700"
        >
          <span class="text-sm font-semibold" data-testid="doc-title">
            {{ projects.currentDocument?.title ?? 'لم يتم اختيار مستند' }}
          </span>
          <button
            class="rounded px-2 py-1 text-sm hover:bg-slate-200 dark:hover:bg-slate-700"
            data-testid="open-settings"
            @click="showSettings = true"
          >
            الإعدادات
          </button>
        </div>
        <EditorPane ref="pane" :open-document="selectDocument" @change="autosave.markDirty()" />
      </main>
    </div>
    <StatusBar />
    <SettingsModal v-if="showSettings" @close="showSettings = false" />
    <div class="fixed bottom-10 start-3 z-50 space-y-2" data-testid="toasts">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="rounded bg-red-600 px-3 py-2 text-sm text-white shadow"
        role="alert"
      >
        {{ t.text }}
      </div>
    </div>
  </div>
</template>
