<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TitleBar from './components/TitleBar.vue'
import Sidebar from './components/Sidebar.vue'
import EditorPane from './components/EditorPane.vue'
import StatusBar from './components/StatusBar.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import RightPanel from './components/RightPanel.vue'
import SettingsModal from './components/SettingsModal.vue'
import ShortcutsDialog from './components/ShortcutsDialog.vue'
import AboutDialog from './components/AboutDialog.vue'
import FileMenu from './components/files/FileMenu.vue'
import BatchDialog from './components/files/BatchDialog.vue'
import ImportPreviewDialog from './components/files/ImportPreviewDialog.vue'
import OcrFailureDialog from './components/files/OcrFailureDialog.vue'
import { useFileStore } from './stores/fileio'
import { zoomAction } from './a11y/zoom'
import { toastClass, toasts } from './api/toast'
import { createAutosave } from './composables/autosave'
import type { DocumentFull } from './api/client'
import { useEditorStore } from './stores/editor'
import { useProjectsStore } from './stores/projects'
import { useSettingsStore } from './stores/settings'
import { useSidecarStore } from './stores/sidecar'
import { useUpdaterStore } from './stores/updater'

const sidecar = useSidecarStore()
const projects = useProjectsStore()
const settings = useSettingsStore()
const editor = useEditorStore()
const files = useFileStore()
const pane = ref<InstanceType<typeof EditorPane> | null>(null)

const autosave = createAutosave({
  delayMs: 5000,
  getText: () => editor.accessor?.getText() ?? '',
  save: (id, text) => projects.saveContent(id, text, !!editor.diacritizedDocs[id]),
  onState: (s) => (editor.saveState = s)
})

let switchSeq = 0
async function selectDocument(id: number): Promise<void> {
  if (projects.currentDocument?.id === id) return // already open: keep the editor state/undo history
  const token = ++switchSeq
  let d: DocumentFull
  for (;;) {
    await autosave.flush() // save the outgoing document first
    d = await projects.fetchDocument(id)
    if (token !== switchSeq) return // a newer selection superseded this one
    // Edits typed while the fetch was in flight belong to the OUTGOING document: save them
    // and fetch again, so the swap below never shows stale server content.
    if (!autosave.isDirty()) break
  }
  // From here on everything is synchronous: swap text, current doc and autosave target together.
  projects.setCurrentDocument(d)
  pane.value?.setText(d.raw_content)
  autosave.setDocument(id)
  editor.loadManualEdits(id, settings.values)
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

function onGlobalKey(e: KeyboardEvent): void {
  const z = zoomAction(e)
  if (z) {
    e.preventDefault()
    void settings.zoom(z)
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === '/') {
    e.preventDefault()
    editor.shortcutsOpen = !editor.shortcutsOpen
  }
}
const focusEl = (sel: string): void => {
  const el = document.querySelector<HTMLElement>(sel)
  el?.focus()
}

onMounted(async () => {
  settings.applyToDom()
  window.addEventListener('keydown', onGlobalKey)
  window.addEventListener('blur', flushNow)
  window.addEventListener('beforeunload', flushNow)
  offFlush = window.mizajAPI?.onBeforeQuitFlush(() => autosave.flush())
  files.registerHooks({ flush: () => autosave.flush(), openDocument: selectDocument })
  await sidecar.init()
  void useUpdaterStore().init()
  if (sidecar.isReady) void bootstrap()
})
watch(
  () => sidecar.isReady,
  (ready, was) => {
    if (ready && !was) void bootstrap()
  }
)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey)
  window.removeEventListener('blur', flushNow)
  window.removeEventListener('beforeunload', flushNow)
  offFlush?.()
  files.registerHooks(null)
  autosave.dispose()
})
</script>

<template>
  <div
    class="flex h-full flex-col bg-white text-slate-900 dark:bg-mizaj-slate dark:text-slate-100"
    data-testid="app-root"
  >
    <a
      href="#editor-region"
      class="sr-only skip-link"
      data-testid="skip-to-editor"
      @click.prevent="focusEl('.cm-content')"
      >انتقل إلى المحرر</a
    >
    <a
      href="#sidebar"
      class="sr-only skip-link"
      data-testid="skip-to-sidebar"
      @click.prevent="focusEl('[data-testid=new-project]')"
      >انتقل إلى قائمة المشاريع</a
    >
    <TitleBar />
    <UpdateBanner />
    <div
      class="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="live-region"
    >
      {{ editor.announcement }}
    </div>
    <div class="flex min-h-0 flex-1">
      <Sidebar @select-document="selectDocument" />
      <main class="flex min-w-0 flex-1 flex-col" aria-label="المحتوى الرئيسي">
        <div
          class="flex items-center justify-between border-b border-slate-200 px-3 py-1 dark:border-slate-700"
        >
          <div class="flex items-center gap-2">
            <FileMenu />
            <span class="text-sm font-semibold" data-testid="doc-title">
              {{ projects.currentDocument?.title ?? 'لم يتم اختيار مستند' }}
            </span>
          </div>
          <button
            class="rounded px-2 py-1 text-sm hover:bg-slate-200 dark:hover:bg-slate-700"
            data-testid="open-settings"
            @click="settings.openSettings()"
          >
            الإعدادات
          </button>
        </div>
        <EditorPane
          ref="pane"
          :open-document="selectDocument"
          :flush-save="autosave.flush"
          @change="autosave.markDirty()"
        />
      </main>
      <RightPanel :open-document="selectDocument" />
    </div>
    <StatusBar />
    <SettingsModal v-if="settings.settingsOpen" @close="settings.closeSettings()" />
    <BatchDialog v-if="files.batchOpen" />
    <ImportPreviewDialog v-if="files.preview" :preview="files.preview" />
    <OcrFailureDialog />
    <ShortcutsDialog v-if="editor.shortcutsOpen" />
    <AboutDialog v-if="editor.aboutOpen" />
    <div
      class="fixed bottom-10 start-3 z-50 space-y-2"
      role="region"
      aria-label="الإشعارات"
      data-testid="toasts"
    >
      <div
        v-for="t in toasts"
        :key="t.id"
        class="rounded px-3 py-2 text-sm text-white shadow"
        :class="toastClass[t.kind]"
        :data-kind="t.kind"
        role="alert"
      >
        {{ t.text }}
      </div>
    </div>
  </div>
</template>
