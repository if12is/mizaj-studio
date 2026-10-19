<script setup lang="ts">
import MotionTransition from '@renderer/components/ui/MotionTransition.vue'
import MotionGroup from '@renderer/components/ui/MotionGroup.vue'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TitleBar from './components/TitleBar.vue'
import AppIcon from './components/ui/AppIcon.vue'
import Sidebar from './components/Sidebar.vue'
import EditorPane from './components/EditorPane.vue'
import StatusBar from './components/StatusBar.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import RightPanel from './components/RightPanel.vue'
import FileMenu from './components/files/FileMenu.vue'
import SplashScreen from './components/ui/SplashScreen.vue'
import SuccessCheck from './components/ui/SuccessCheck.vue'
import GeminiConsentDialog from './components/GeminiConsentDialog.vue'
import { useGeminiStore } from './stores/gemini'
import { editorReady } from './lib/boot'
import { whenIdle } from './lib/idle'
import { lazyDialog } from './lib/lazy'
import { useFileStore } from './stores/fileio'
import { zoomAction } from './a11y/zoom'
import { toastClass, toasts } from './api/toast'
import { createAutosave } from './composables/autosave'
import type { DocumentFull } from './api/client'
import { useEditorStore } from './stores/editor'
import { useProofreadStore } from './stores/proofread'
import { useProjectsStore } from './stores/projects'
import { useSettingsStore } from './stores/settings'
import { useSidecarStore } from './stores/sidecar'
import { useUpdaterStore } from './stores/updater'

// dialogs are separate chunks: fetched the first time they open
const SettingsModal = lazyDialog(() => import('./components/SettingsModal.vue'))
const ShortcutsDialog = lazyDialog(() => import('./components/ShortcutsDialog.vue'))
const AboutDialog = lazyDialog(() => import('./components/AboutDialog.vue'))
const BatchDialog = lazyDialog(() => import('./components/files/BatchDialog.vue'))
const ImportPreviewDialog = lazyDialog(() => import('./components/files/ImportPreviewDialog.vue'))
const OcrFailureDialog = lazyDialog(() => import('./components/files/OcrFailureDialog.vue'))
const ProofreadDialog = lazyDialog(() => import('./components/ProofreadDialog.vue'))

const sidecar = useSidecarStore()
const projects = useProjectsStore()
const settings = useSettingsStore()
const editor = useEditorStore()
const proofread = useProofreadStore()
const files = useFileStore()
const gemini = useGeminiStore()
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

/** The open document is being deleted: drop pending autosave and empty the editor. */
function closeCurrent(): void {
  switchSeq++
  autosave.setDocument(null)
  pane.value?.setText('')
}

const flushNow = (): void => void autosave.flush()
let offFlush: (() => void) | undefined

async function bootstrap(): Promise<void> {
  try {
    await settings.load()
    void gemini.load()
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
  whenIdle(() => void useUpdaterStore().init(), 3000) // not needed for first interaction
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
      <Sidebar @select-document="selectDocument" @closing-current="closeCurrent" />
      <div class="flex min-w-0 flex-1 flex-col">
        <main class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="المحتوى الرئيسي">
          <div
            class="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900/40"
            data-testid="menubar"
          >
            <div class="flex items-center gap-2" role="group" aria-label="القوائم">
              <FileMenu />
            </div>
            <div
              class="flex max-w-[28rem] items-center gap-2 truncate rounded-full border px-3 py-0.5 text-sm"
              :class="
                projects.currentDocument
                  ? 'border-slate-300 bg-white font-semibold dark:border-slate-600 dark:bg-slate-800'
                  : 'border-dashed border-slate-300 text-slate-500 dark:border-slate-600'
              "
              :title="projects.currentDocument?.title ?? ''"
              data-testid="doc-pill"
            >
              <span
                v-if="projects.currentDocument"
                class="h-2 w-2 shrink-0 rounded-full"
                :class="
                  editor.saveState === 'saved' ? 'bg-mizaj-emerald' : 'animate-pulse bg-mizaj-amber'
                "
                :title="
                  editor.saveState === 'saved'
                    ? 'محفوظ'
                    : editor.saveState === 'saving'
                      ? 'جاري الحفظ'
                      : 'تعديلات غير محفوظة'
                "
                data-testid="doc-modified-dot"
                :data-state="editor.saveState"
              />
              <span class="truncate" data-testid="doc-title">
                {{ projects.currentDocument?.title ?? 'لم يتم اختيار مستند' }}
              </span>
            </div>
            <div class="flex justify-end">
              <button
                class="flex items-center gap-1.5 rounded-md border border-slate-300 bg-slate-100 px-3 py-1 text-sm hover:border-mizaj-emerald/60 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-700/60 dark:hover:bg-slate-700"
                data-testid="open-settings"
                title="الإعدادات"
                @click="settings.openSettings()"
              >
                <AppIcon name="settings" :size="14" />
                الإعدادات
              </button>
            </div>
          </div>
          <EditorPane
            ref="pane"
            :open-document="selectDocument"
            :flush-save="autosave.flush"
            @change="autosave.markDirty()"
          />
        </main>
        <RightPanel place="bottom" :open-document="selectDocument" />
      </div>
      <RightPanel place="side" :open-document="selectDocument" />
    </div>
    <StatusBar />
    <MotionTransition name="m-modal">
      <SettingsModal v-if="settings.settingsOpen" @close="settings.closeSettings()" />
    </MotionTransition>
    <MotionTransition name="m-modal">
      <BatchDialog v-if="files.batchOpen" />
    </MotionTransition>
    <MotionTransition name="m-modal">
      <ImportPreviewDialog v-if="files.preview" :preview="files.preview" />
    </MotionTransition>
    <MotionTransition name="m-modal">
      <OcrFailureDialog v-if="files.ocrFailure" />
    </MotionTransition>
    <MotionTransition name="m-modal">
      <ProofreadDialog v-if="proofread.open" />
    </MotionTransition>
    <MotionTransition name="m-modal">
      <ShortcutsDialog v-if="editor.shortcutsOpen" />
    </MotionTransition>
    <MotionTransition name="m-modal">
      <AboutDialog v-if="editor.aboutOpen" />
      <GeminiConsentDialog v-if="gemini.consentOpen" />
    </MotionTransition>
    <MotionGroup
      tag="div"
      name="m-toast"
      class="fixed bottom-10 start-3 z-50 flex flex-col gap-2"
      role="region"
      aria-label="الإشعارات"
      data-testid="toasts"
    >
      <div
        v-for="t in toasts"
        :key="t.id"
        class="flex items-center gap-2 rounded px-3 py-2 text-sm text-white shadow"
        :class="toastClass[t.kind]"
        :data-kind="t.kind"
        role="alert"
      >
        <SuccessCheck v-if="t.kind === 'success'" :size="16" />
        <span>{{ t.text }}</span>
      </div>
    </MotionGroup>
    <MotionTransition name="m-splash">
      <SplashScreen v-if="!editorReady" />
    </MotionTransition>
  </div>
</template>
