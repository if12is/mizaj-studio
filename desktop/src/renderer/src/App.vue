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
import TabStrip from './components/TabStrip.vue'
import RightPanel from './components/RightPanel.vue'
import FileMenu from './components/files/FileMenu.vue'
import HistoryHost from './components/history/HistoryHost.vue'
import SplashScreen from './components/ui/SplashScreen.vue'
import SuccessCheck from './components/ui/SuccessCheck.vue'
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
import { useTabsStore } from './stores/tabs'
import { usePaletteStore } from './stores/palette'
import { findCommandForKey, runCommand } from './commands/registry'
import type { TabViewState } from './tabs/viewState'
import { notify } from './api/toast'
import { touchRecentFile } from './lib/recentFiles'
import { useExtrasStore } from './stores/extras'

// dialogs are separate chunks: fetched the first time they open
const SettingsModal = lazyDialog(() => import('./components/SettingsModal.vue'))
const ShortcutsDialog = lazyDialog(() => import('./components/ShortcutsDialog.vue'))
const AboutDialog = lazyDialog(() => import('./components/AboutDialog.vue'))
const BatchDialog = lazyDialog(() => import('./components/files/BatchDialog.vue'))
const ImportPreviewDialog = lazyDialog(() => import('./components/files/ImportPreviewDialog.vue'))
const OcrFailureDialog = lazyDialog(() => import('./components/files/OcrFailureDialog.vue'))
const FeatureGuideHost = lazyDialog(() => import('./components/ui/FeatureGuideHost.vue'))
const CommandPalette = lazyDialog(() => import('./components/CommandPalette.vue'))
const GeminiConsentDialog = lazyDialog(() => import('./components/GeminiConsentDialog.vue'))
const ProofreadDialog = lazyDialog(() => import('./components/ProofreadDialog.vue'))
const OneStepSummaryDialog = lazyDialog(() => import('./components/OneStepSummaryDialog.vue'))
const TrackedExportDialog = lazyDialog(() => import('./components/files/TrackedExportDialog.vue'))
const SearchPanel = lazyDialog(() => import('./components/SearchPanel.vue'))
const PrintPreviewDialog = lazyDialog(() => import('./components/print/PrintPreviewDialog.vue'))
const TourHost = lazyDialog(() => import('./components/tour/TourHost.vue'))

const sidecar = useSidecarStore()
const projects = useProjectsStore()
const settings = useSettingsStore()
const editor = useEditorStore()
const proofread = useProofreadStore()
const files = useFileStore()
const gemini = useGeminiStore()
const tabs = useTabsStore()
const palette = usePaletteStore()
const extras = useExtrasStore()
const pane = ref<InstanceType<typeof EditorPane> | null>(null)

const autosave = createAutosave({
  delayMs: 5000,
  getText: () => editor.accessor?.getText() ?? '',
  save: (id, text) => projects.saveContent(id, text, !!editor.diacritizedDocs[id]),
  onState: (s) => (editor.saveState = s)
})

// ---------------------------------------------------------------- tabs
// One CodeMirror view is shared by all tabs. Leaving a tab stores its editor state (text, undo
// history, selection) + scroll/page view in `snapshots`; coming back restores it. Per-document
// features (tashkeel, proofreading, Gemini, export) work on whatever the active tab shows.
const snapshots = new Map<string, TabViewState>()
let loadedTabId: string | null = null // the tab whose document the editor currently shows
let switchSeq = 0
watch(
  () => editor.saveState,
  (s) => {
    if (tabs.activeId) tabs.setDirty(tabs.activeId, s !== 'saved')
  },
  { flush: 'sync' }
)

/** Make a tab the visible one: save the outgoing document, keep its editor state, show the target. */
async function activateTab(id: string, force = false): Promise<void> {
  const target = tabs.byId(id)
  if (!target || (!force && id === loadedTabId)) return
  const token = ++switchSeq
  let d: DocumentFull | null = null
  for (let attempt = 0; ; attempt++) {
    await autosave.flush() // save the outgoing document first
    if (token !== switchSeq) return // a newer selection superseded this one
    if (target.documentId !== null) {
      try {
        d = await projects.fetchDocument(target.documentId)
      } catch {
        if (token === switchSeq) dropTab(id) // the document is gone: error toast already shown
        return
      }
      if (token !== switchSeq) return
    }
    // Edits typed while the fetch was in flight belong to the OUTGOING document: save them
    // and fetch again, so the swap below never shows stale server content. After a few failed
    // saves go on anyway: the unsaved text travels with the outgoing tab's snapshot.
    if (!autosave.isDirty() || attempt >= 2) break
  }
  // From here on everything is synchronous: snapshot outgoing, swap text, current doc, autosave.
  const outId = loadedTabId
  if (outId && outId !== id && tabs.byId(outId)) {
    const snap = pane.value?.captureState()
    if (snap) snapshots.set(outId, snap)
    tabs.setDirty(outId, autosave.isDirty())
  }
  if (outId === id) snapshots.delete(id) // forced reload of the same tab
  tabs.setActive(id)
  loadedTabId = id
  const snap = snapshots.get(id)
  if (!d) {
    projects.clearCurrentDocument()
    autosave.setDocument(null)
    if (snap) pane.value?.restoreState(snap)
    else pane.value?.setText('')
    return
  }
  projects.setCurrentDocument(d)
  autosave.setDocument(d.id)
  if (snap) pane.value?.restoreState(snap)
  else {
    pane.value?.setText(d.raw_content)
    pane.value?.restoreView(d.id) // cursor + scroll where the user stopped
  }
  if (snap && target.dirty) autosave.markDirty() // unsaved text that could not be stored yet
  editor.loadManualEdits(d.id, settings.values)
  if (d.diacritized_content) editor.diacritizedDocs = { ...editor.diacritizedDocs, [d.id]: true }
  tabs.assign(id, { documentId: d.id, projectId: d.project_id, title: d.title })
  tabs.touchRecent({ documentId: d.id, projectId: d.project_id, title: d.title })
  touchRecentFile({ documentId: d.id, projectId: d.project_id, title: d.title })
}

/** Open a document: focus its tab if it is open, else reuse an empty active tab, else add a tab. */
async function openDocument(id: number): Promise<void> {
  const existing = tabs.byDocument(id)
  if (existing) return activateTab(existing.id)
  const meta = Object.values(projects.documents)
    .flat()
    .find((x) => x.id === id)
  let tab = tabs.active
  if (!tab || tab.documentId !== null) tab = tabs.add({}, true)
  tabs.assign(tab.id, {
    documentId: id,
    projectId: meta?.project_id ?? 0,
    title: meta?.title ?? '…'
  })
  await activateTab(tab.id, tab.id === loadedTabId)
}

async function newTab(): Promise<void> {
  const cur = tabs.active
  if (cur && cur.documentId === null && cur.id === loadedTabId) return
  const t = tabs.add({}, true)
  await activateTab(t.id)
}
function nextTab(): void {
  const t = tabs.neighbour(1)
  if (t) void activateTab(t.id)
}
function prevTab(): void {
  const t = tabs.neighbour(-1)
  if (t) void activateTab(t.id)
}

/** Remove a tab without asking (its document is gone, or the user chose not to save). */
async function finishClose(id: string): Promise<void> {
  const wasActive = id === tabs.activeId
  if (wasActive) autosave.setDocument(null) // drop pending autosave of the closing document
  const next = tabs.remove(id)
  snapshots.delete(id)
  if (!wasActive) return
  if (next) return activateTab(next.id, true)
  const blank = tabs.add({}, false)
  await activateTab(blank.id, true)
}
const dropTab = (id: string): void => void finishClose(id)

async function saveTab(id: string): Promise<boolean> {
  if (id === tabs.activeId) {
    await autosave.flush()
    return !autosave.isDirty()
  }
  const t = tabs.byId(id)
  const snap = snapshots.get(id)
  if (!t || t.documentId === null || !snap) return true
  try {
    await projects.saveContent(
      t.documentId,
      snap.state.doc.toString(),
      !!editor.diacritizedDocs[t.documentId]
    )
    return true
  } catch {
    return false
  }
}
/** Close a tab; unsaved work asks first (save / discard / cancel). */
async function requestClose(id: string): Promise<void> {
  const t = tabs.byId(id)
  if (!t) return
  if (id === tabs.activeId) await autosave.flush()
  const dirty = id === tabs.activeId ? autosave.isDirty() : t.dirty
  if (dirty && t.documentId !== null) tabs.closePrompt = id
  else await finishClose(id)
}
async function onResolveClose(choice: 'save' | 'discard' | 'cancel'): Promise<void> {
  const id = tabs.closePrompt
  tabs.closePrompt = null
  if (!id || choice === 'cancel') return
  if (choice === 'save' && !(await saveTab(id))) {
    notify('تعذر حفظ المستند؛ لم يُغلق التبويب.')
    return
  }
  await finishClose(id)
}
const closeActiveTab = (): void => {
  if (tabs.activeId) void requestClose(tabs.activeId)
}

/** The open document is being deleted: drop pending autosave (its tab closes once it is gone). */
function closeCurrent(): void {
  autosave.setDocument(null)
}
// Tabs follow the document lists: a deleted document/project closes its tabs, renames update titles.
watch(
  () => projects.documents,
  (now, before) => {
    const gone = new Set<number>()
    for (const [pid, list] of Object.entries(before)) {
      const cur = now[Number(pid)]
      for (const d of list) if (!cur || !cur.some((x) => x.id === d.id)) gone.add(d.id)
    }
    for (const list of Object.values(now)) for (const d of list) tabs.setTitle(d.id, d.title)
    if (!gone.size) return
    tabs.forgetDocuments(gone)
    for (const t of [...tabs.tabs])
      if (t.documentId !== null && gone.has(t.documentId)) dropTab(t.id)
  }
)

/** Re-open the tabs of the last session (only documents that still exist). */
let restored = false
async function restoreTabs(): Promise<void> {
  if (restored) return
  restored = true
  if (tabs.tabs.length) return // the user already opened something while the app was starting
  tabs.restore()
  const known = new Set(
    Object.values(projects.documents)
      .flat()
      .map((d) => d.id)
  )
  tabs.prune((id) => known.has(id))
  if (!tabs.tabs.length) {
    // nothing to restore: the editor already shows the empty state, do not reset it
    const blank = tabs.add({}, false)
    tabs.setActive(blank.id)
    loadedTabId = blank.id
    return
  }
  const first = tabs.active ?? tabs.tabs[0]
  await activateTab(first.id, true)
}

const flushNow = (): void => void autosave.flush()
let offFlush: (() => void) | undefined
let offCommands: (() => void) | undefined
let offGuide: (() => void) | undefined
let offExtras: (() => void) | undefined
let unmounted = false

async function bootstrap(): Promise<void> {
  try {
    await settings.load()
    void gemini.load()
    await projects.loadProjects()
    await restoreTabs()
  } catch {
    /* error toast shown by api client */
  }
  extras.shellReady = true
  // first run: the guided tour (a separate chunk, off the startup path)
  whenIdle(() => void import('./tour/autostart').then((m) => m.maybeStartTour()), 1200)
}

/** App-wide key bindings come from the command registry (Ctrl+K, Ctrl+T, Ctrl+W, Ctrl+Tab...). */
function onCommandKey(e: KeyboardEvent): void {
  const c = findCommandForKey(e)
  if (!c || (palette.open && c.id !== 'palette.open')) return
  e.preventDefault()
  e.stopPropagation()
  void runCommand(c.id)
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
  window.addEventListener('keydown', onCommandKey, true)
  window.addEventListener('keydown', onGlobalKey)
  window.addEventListener('blur', flushNow)
  window.addEventListener('beforeunload', flushNow)
  offFlush = window.mizajAPI?.onBeforeQuitFlush(() => autosave.flush())
  files.registerHooks({ flush: () => autosave.flush(), openDocument })
  // the command registry and guide topics are a separate chunk: off the startup path
  void Promise.all([
    import('./commands/builtin'),
    import('@renderer/search/guideTopics'),
    import('./commands/extras')
  ]).then(
    ([{ registerBuiltinCommands }, { registerQuickGuideTopics }, { registerExtraCommands }]) => {
      if (unmounted) return
      offExtras = registerExtraCommands()
      offCommands = registerBuiltinCommands({
        editorActions: () => pane.value?.actions,
        newTab: () => void newTab(),
        closeActiveTab,
        nextTab,
        prevTab
      })
      offGuide = registerQuickGuideTopics()
    }
  )
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
  window.removeEventListener('keydown', onCommandKey, true)
  window.removeEventListener('keydown', onGlobalKey)
  unmounted = true
  offCommands?.()
  offGuide?.()
  offExtras?.()
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
    <TabStrip
      @activate="activateTab($event)"
      @close="requestClose"
      @new="newTab"
      @resolve-close="onResolveClose"
    />
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
      <Sidebar @select-document="openDocument" @closing-current="closeCurrent" />
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
            :open-document="openDocument"
            :flush-save="autosave.flush"
            @change="autosave.markDirty()"
          />
        </main>
        <RightPanel place="bottom" :open-document="openDocument" />
      </div>
      <RightPanel place="side" :open-document="openDocument" />
    </div>
    <StatusBar />
    <HistoryHost :flush="autosave.flush" />
    <MotionTransition name="m-modal">
      <CommandPalette v-if="palette.open" :open-document="openDocument" />
    </MotionTransition>
    <MotionTransition name="m-modal">
      <SearchPanel v-if="extras.searchOpen" :open-document="openDocument" />
    </MotionTransition>
    <MotionTransition name="m-modal">
      <PrintPreviewDialog v-if="extras.printOpen" :flush="autosave.flush" />
    </MotionTransition>
    <TourHost v-if="extras.tourActive" />
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
      <OneStepSummaryDialog v-if="proofread.summary" />
    </MotionTransition>
    <MotionTransition name="m-modal">
      <TrackedExportDialog v-if="files.trackedOptions" />
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
    <FeatureGuideHost />
    <MotionTransition name="m-splash">
      <SplashScreen v-if="!editorReady" />
    </MotionTransition>
  </div>
</template>
