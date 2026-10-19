<script setup lang="ts">
import MotionTransition from '@renderer/components/ui/MotionTransition.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { useApi } from '@renderer/api'
import { ApiError } from '@renderer/api/client'
import { notify } from '@renderer/api/toast'
import { computeDensity, countWords } from '@renderer/editor/arabic'
import { createThrottle } from '@renderer/composables/throttle'
import { createDocumentState } from '@renderer/editor/documentState'
import { editorPaletteClass } from '@renderer/editor/fontClass'
import { mizajEditorExtensions } from '@renderer/editor'
import type { Suggestion } from '@renderer/editor/inspector'
import { readOnlyCompartment, useTashkeelRun } from '@renderer/composables/useTashkeelRun'
import { useDictionaryStore } from '@renderer/stores/dictionary'
import { useEditorStore } from '@renderer/stores/editor'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import { useSidecarStore } from '@renderer/stores/sidecar'
import DropOverlay from './DropOverlay.vue'
import ProgressBar from './ProgressBar.vue'
import PageView from './PageView.vue'
import EnginePill from './ui/EnginePill.vue'
import { lazyDialog, lazyPanel } from '@renderer/lib/lazy'
import { markEditorReady } from '@renderer/lib/boot'
import { freshExtension } from '@renderer/editor/fresh'

// rarely used parts are separate chunks (diff view pulls in @codemirror/merge)
const DiffView = lazyPanel(() => import('./DiffView.vue'))
const StatsPanel = lazyPanel(() => import('./StatsPanel.vue'))
const NormalizeDialog = lazyDialog(() => import('./NormalizeDialog.vue'))
import { useSpellCheck } from '@renderer/composables/useSpellCheck'
import { useSpellingStore } from '@renderer/stores/spelling'
import { createThrottle as throttle2 } from '@renderer/composables/throttle'
import { insertAtCursorSpec, safeEditSpec, safeEditsSpec } from '@renderer/editor/safeEdit'
import { goToIssue } from '@renderer/editor/spelling'
import {
  findStep,
  replaceAll as findReplaceAll,
  replaceCurrent,
  setFind,
  findField
} from '@renderer/editor/find'
import {
  acceptAll,
  addPending,
  pendingField,
  rejectAll,
  type PendingItem
} from '@renderer/editor/pending'
import { paragraphsFor } from '@renderer/editor/paragraphs'
import { LONG_LINE_THRESHOLD, longestLine, splitLongLineEdits } from '@renderer/editor/longLines'
import { richPasteHandler } from '@renderer/editor/paste'
import { stripMarks } from '@renderer/editor/arabic'
import { isolateHistory } from '@codemirror/commands'
import { useTts } from '@renderer/composables/useTts'
import FindBar from './FindBar.vue'
import ToolbarToggle from './ui/ToolbarToggle.vue'
import AppIcon from './ui/AppIcon.vue'
import { useEditorQuality } from '@renderer/composables/useEditorQuality'
import { useQuranDetect } from '@renderer/composables/useQuranDetect'
import { useQualityStore } from '@renderer/stores/quality'
import { useGeminiStore } from '@renderer/stores/gemini'
import { reviewKeep, reviewStep, type ConfWord } from '@renderer/editor/confidence'
import { openInspectorAt } from '@renderer/editor/inspector'
import ReviewBar from './ReviewBar.vue'
import type { TabViewState } from '@renderer/tabs/viewState'
import { normalizeSpec } from '@renderer/editor/normalizeEdits'

const props = defineProps<{
  openDocument: (id: number) => Promise<void>
  /** flush autosave so the server has the latest text before exporting */
  flushSave: () => Promise<void>
}>()
const emit = defineEmits<{ (e: 'change'): void }>()
const editor = useEditorStore()
const settings = useSettingsStore()
const sidecar = useSidecarStore()
const projects = useProjectsStore()
const dictionary = useDictionaryStore()
const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
let silent = false

const quality = useQualityStore()
const gemini = useGeminiStore()
const quranDetect = useQuranDetect(() => view)
watch(
  () => quality.quranRevision,
  () => void quranDetect.detectNow()
)
const quals = useEditorQuality(() => view)
const spell = useSpellCheck(() => view)
const spelling = useSpellingStore()
let pendingMarks: import('@renderer/editor/spellModel').SpellMark[] | null = null
const flushMarks = throttle2(() => {
  if (pendingMarks) spelling.marks = pendingMarks
}, 300)

const tts = useTts()

// «عرض الصفحة»: server-rendered, Word-like read-only view (CodeMirror stays mounted underneath)
const pageView = ref(false)
const pageZoom = ref(100)
const pageTick = ref(0)
function togglePageView(): void {
  pageView.value = !pageView.value
  if (pageView.value) pageTick.value++
}
function zoomPage(delta: number): void {
  pageZoom.value = Math.min(200, Math.max(50, pageZoom.value + delta))
}
watch(
  () => editor.runState,
  (s, prev) => {
    if (pageView.value && s === 'done' && prev !== 'done') pageTick.value++
  }
)

const run = useTashkeelRun(
  () => view,
  () => emit('change')
)

const paletteClass = computed(() =>
  editorPaletteClass(settings.values.editor_font, settings.colored, settings.values.diacritic_color)
)

function refreshStats(): void {
  if (!view) return
  const text = view.state.doc.toString()
  editor.wordCount = countWords(text)
  editor.density = computeDensity(text).density
  let m = 0
  for (const l of view.state.doc.iterLines()) if (l.length > m) m = l.length
  editor.longestLine = m
}

let pendingSeq = 0
/** 7.2.2: tashkeel the paragraph at the cursor / the selected paragraphs as a PREVIEW. */
async function paragraphRun(): Promise<void> {
  const v = view
  if (!v) return
  const sel = v.state.selection.main
  const paras = paragraphsFor(v.state.doc, sel.from, sel.to)
  if (!paras.length) return notify('لا توجد فقرة عربية لتشكيلها هنا.', { kind: 'info' })
  if (paras.length > 60)
    return notify('عدد الفقرات كبير؛ استخدم «تشكيل» لكامل التحديد.', { kind: 'info' })
  const doc = v.state.doc
  const api = useApi()
  const results = await Promise.all(
    paras.map(async (p) => {
      try {
        const r = await api.post<{ text: string; words?: ConfWord[] }>('/api/tashkeel', {
          text: p.text,
          mode: settings.values.engine_mode,
          level: settings.values.tashkeel_level,
          confidence: quality.confidenceShow,
          confidence_threshold: quality.confidenceThreshold,
          protect_quran: quality.quranProtect,
          ...(quality.poetryOn ? { poetry: true } : {})
        })
        return r
      } catch {
        return null
      }
    })
  )
  if (view !== v || v.state.doc !== doc)
    return notify('تغيّر النص أثناء التشكيل؛ أعد المحاولة.', { kind: 'info' })
  const items: PendingItem[] = []
  paras.forEach((p, i) => {
    const res = results[i]
    const out = res?.text
    // never accept a result that changes base letters
    if (out && out !== p.text && stripMarks(out) === stripMarks(p.text))
      items.push({
        id: ++pendingSeq,
        from: p.from,
        to: p.to,
        original: p.text,
        proposed: out,
        words: res?.words
      })
  })
  if (!items.length) return notify('لا تغييرات مقترحة لهذه الفقرة.', { kind: 'info' })
  v.dispatch({ effects: addPending.of(items) })
  editor.announce(`${items.length} فقرة جاهزة للمراجعة: اقبل أو ارفض`)
}

const quranHintHidden = ref(false)
function dismissQuranHint(): void {
  quranHintHidden.value = true
  void settings.update({ quran_hint_dismissed: 'true' })
}
function toggleReview(): void {
  if (!view) return
  if (quality.review.active) {
    quality.review.active = false
    return
  }
  quality.review.active = true
  if (!reviewStep(quals.confidence, view, 1))
    notify('لا توجد كلمات منخفضة الثقة للمراجعة. شكّل النص أولاً.', { kind: 'info' })
}

function splitLongLines(): number {
  if (!view) return 0
  const lines: { from: number; text: string }[] = []
  let pos = 0
  for (const t of view.state.doc.iterLines()) {
    lines.push({ from: pos, text: t })
    pos += t.length + 1
  }
  const { edits, lines: n } = splitLongLineEdits(lines)
  if (!edits.length) return 0
  view.dispatch({
    changes: edits,
    userEvent: 'split.long-lines',
    annotations: [isolateHistory.of('full')]
  })
  editor.splitLines += n
  editor.announce(`تم تقسيم ${n} فقرة طويلة`)
  return n
}
const statsThrottle = createThrottle(refreshStats, 400)
const scheduleStats = (): void => statsThrottle.trigger()
// refresh on every run transition (start/pause/resume/finish), not just on typing
watch(
  () => editor.runState,
  () => refreshStats()
)

async function fetchSuggestions(bare: string): Promise<Suggestion[]> {
  return useApi().get<Suggestion[]>(`/api/word-suggestions?word=${encodeURIComponent(bare)}`, true)
}

async function saveToDictionary(bare: string, form: string): Promise<void> {
  const api = useApi()
  try {
    await api.request(
      'POST',
      '/api/dictionary',
      { word_or_phrase: bare, diacritized_form: form },
      true
    )
    notify('تم حفظ الكلمة في قاموسك.', { kind: 'success' })
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      if (!window.confirm('الكلمة موجودة في قاموسك. هل تريد تحديث تشكيلها؟')) return
      try {
        dictionary.query = bare
        await dictionary.load()
        const entry = dictionary.entries.find((x) => x.word_or_phrase === bare)
        if (entry) {
          await dictionary.update(entry.id, form)
          notify('تم تحديث الكلمة في قاموسك.', { kind: 'success' })
        }
      } catch {
        /* toast already shown */
      } finally {
        dictionary.query = ''
      }
    } else if (e instanceof ApiError) {
      notify(e.messageAr)
    }
  }
}

function extensions(): Extension[] {
  return [
    history(),
    mizajEditorExtensions({
      onDiacritize: () => void run.start(),
      onParagraphRun: () => void paragraphRun(),
      find: {
        onOpen: () => (editor.findOpen = true),
        onClose: () => (editor.findOpen = false),
        onChange: (i) => (editor.findInfo = i)
      },
      pending: { onChange: (n) => (editor.pendingCount = n) },
      spelling: {
        fetchSuggestions: spell.fetchSuggestions,
        ignore: spell.ignoreWord,
        addToDictionary: spell.addToDictionary,
        onIssues: (m) => {
          pendingMarks = m
          flushMarks.trigger()
        },
        onFullCheck: () => void spell.checkNow(true)
      },
      confidence: quals.confidence,
      quran: quals.quran,
      inspector: {
        fetchSuggestions,
        saveToDictionary,
        onManualEdit: (n, w) => editor.addManualEdits(projects.currentDocument?.id ?? 0, n, w),
        ...quals.inspector
      }
    }),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    readOnlyCompartment.of(EditorState.readOnly.of(false)),
    freshExtension(),
    EditorView.lineWrapping,
    EditorView.perLineTextDirection.of(true),
    richPasteHandler(() => true),
    EditorView.contentAttributes.of({
      dir: 'rtl',
      lang: 'ar',
      'data-testid': 'editor-content',
      'aria-label': 'محرر النص',
      'aria-multiline': 'true'
    }),
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) {
        editor.cursorLine = u.state.doc.lineAt(u.state.selection.main.head).number
      }
      if (u.docChanged) {
        scheduleStats()
        if (!silent) emit('change')
      }
      if (u.docChanged || u.viewportChanged) {
        spell.schedule()
        quranDetect.schedule()
      }
    })
  ]
}

/** Replace the whole document with a fresh state (resets undo history). */
function setText(text: string, notifyChange = false): void {
  if (!view) return
  run.reset()
  silent = !notifyChange
  view.setState(createDocumentState(text, extensions()))
  silent = false
  editor.cursorLine = 1
  spelling.marks = []
  spell.schedule()
  quranDetect.schedule()
  quality.review = { active: false, total: 0, reviewed: 0, remaining: 0 }
  editor.diffBase = null
  editor.showDiff = false
  editor.pendingCount = 0
  pageView.value = false
  refreshStats()
  if (notifyChange) emit('change')
}

function captureState(): TabViewState | null {
  if (!view) return null
  return {
    state: view.state,
    scrollTop: view.scrollDOM.scrollTop,
    pageView: pageView.value,
    pageZoom: pageZoom.value,
    diffBase: editor.diffBase,
    showDiff: editor.showDiff
  }
}
/** Switch to a tab's saved editor state (keeps its undo history, selection and scroll). */
function restoreState(snap: TabViewState): void {
  if (!view) return
  run.reset()
  silent = true
  view.setState(snap.state)
  silent = false
  pageView.value = snap.pageView
  pageZoom.value = snap.pageZoom
  if (snap.pageView) pageTick.value++
  editor.diffBase = snap.diffBase
  editor.showDiff = snap.showDiff
  editor.cursorLine = snap.state.doc.lineAt(snap.state.selection.main.head).number
  editor.pendingCount = snap.state.field(pendingField).length
  editor.findInfo = { count: 0, current: -1 }
  spelling.marks = []
  spell.schedule()
  quranDetect.schedule()
  quality.review = { active: false, total: 0, reviewed: 0, remaining: 0 }
  refreshStats()
  const v = view
  requestAnimationFrame(() => {
    if (view === v) v.scrollDOM.scrollTop = snap.scrollTop
  })
}

async function loadSample(): Promise<void> {
  // 400 KB of text: fetched on demand so it never sits in the startup bundle
  const { default: sampleText } = await import('@fixtures/sample_long.txt?raw')
  setText(sampleText, true)
}

async function openAndMaybeDiacritize(id: number, diacritize: boolean): Promise<void> {
  await props.openDocument(id)
  if (diacritize) await run.start()
}

async function exportDocx(): Promise<void> {
  const doc = projects.currentDocument
  const api = window.mizajAPI
  if (!doc) return
  let target: string | null = null
  if (api?.showSaveDialog) target = await api.showSaveDialog(`${doc.title}.docx`)
  else target = window.prompt('مسار ملف DOCX الناتج (مطلق)', '') || null
  if (!target) return
  try {
    await props.flushSave()
    const r = await useApi().request<{ target_path: string }>(
      'POST',
      '/api/docx/export',
      {
        document_id: doc.id,
        target_path: target,
        mode: settings.values.engine_mode,
        level: settings.values.tashkeel_level
      },
      true
    )
    notify(`تم تصدير الملف: ${r.target_path}`, { kind: 'success' })
  } catch (e) {
    if (!(e instanceof ApiError)) return notify('تعذر تصدير الملف.')
    if (e.errorCode === 'ERR_DOCX_WRITE_LOCKED')
      notify('الملف مفتوح في برنامج آخر. أغلق Word أو اختر اسماً/مساراً آخر ثم أعد التصدير.')
    else if (e.errorCode === 'ERR_DISK_FULL')
      notify('لا توجد مساحة كافية على القرص. حرّر مساحة ثم أعد المحاولة.')
    else if (e.errorCode === 'ERR_DOCX_CORRUPT') notify('ملف Word تالف أو غير صالح.')
    else notify(e.messageAr)
  }
}

// re-check / clear when the spelling settings change, and once a tashkeel run is over
watch(
  () => [
    settings.values.spell_check_enabled,
    settings.values.spell_cat_spelling,
    settings.values.spell_cat_pattern,
    settings.values.spell_cat_punctuation
  ],
  () => {
    if (settings.values.spell_check_enabled === 'false') spell.clear()
    else void spell.checkNow(false)
  }
)
watch(
  () => editor.runState,
  (s) => {
    if (s === 'idle' || s === 'done') spell.schedule()
  }
)

onMounted(() => {
  view = new EditorView({
    state: EditorState.create({ doc: '', extensions: extensions() }),
    parent: host.value as HTMLDivElement
  })
  editor.register({
    getText: () => view?.state.doc.toString() ?? '',
    setText: (t) => setText(t),
    insertText: (t) => {
      if (!view) return
      view.dispatch(insertAtCursorSpec(view.state, t, 'input.legal'))
      view.focus()
    },
    applyEdit: (from, to, expected, insert) => {
      if (!view) return false
      const spec = safeEditSpec(view.state, from, to, expected, insert, 'legal.apply')
      if (!spec) return false
      view.dispatch(spec)
      return true
    },
    applyEdits: (edits) => {
      if (!view) return false
      const spec = safeEditsSpec(view.state, edits, 'edit.batch')
      if (!spec) return false
      view.dispatch(spec)
      return true
    },
    jumpTo: (from, to) => {
      if (!view) return
      const len = view.state.doc.length
      view.dispatch({
        selection: { anchor: Math.min(from, len), head: Math.min(to, len) },
        effects: EditorView.scrollIntoView(Math.min(from, len), { y: 'center' })
      })
      view.focus()
    },
    find: {
      set: (p) => {
        if (!view) return
        view.dispatch({
          effects: setFind.of({
            query: p.query ?? view.state.field(findField).query,
            replacement: p.replacement ?? view.state.field(findField).replacement,
            stripReplacementMarks: p.stripReplacementMarks ?? false,
            options: {
              ignoreMarks: p.ignoreMarks ?? true,
              foldLetters: p.foldLetters ?? false,
              wholeWord: p.wholeWord ?? false
            }
          })
        })
      },
      step: (d) => view && findStep(view, d),
      replace: () => view && replaceCurrent(view),
      replaceAll: () => (view ? findReplaceAll(view) : 0),
      clear: () => view?.dispatch({ effects: setFind.of({ query: '' }) })
    },
    selectionInfo: () => {
      if (!view) return { from: 0, to: 0, text: '' }
      const s = view.state.selection.main
      return s.empty
        ? { from: 0, to: view.state.doc.length, text: view.state.doc.toString() }
        : { from: s.from, to: s.to, text: view.state.sliceDoc(s.from, s.to) }
    },
    currentLine: () => (view ? view.state.doc.lineAt(view.state.selection.main.head).text : ''),
    applyNormalize: (base, edits, selected) => {
      if (!view) return { applied: 0, skipped: 0 }
      const r = normalizeSpec(view.state, base, edits, selected)
      if (r.spec) view.dispatch(r.spec)
      return { applied: r.applied, skipped: r.skipped }
    },
    getReadText: () => {
      if (!view) return ''
      const s = view.state.selection.main
      return s.empty ? view.state.doc.toString() : view.state.sliceDoc(s.from, s.to)
    },
    splitLongLines,
    spellNav: (dir) => {
      if (view) {
        goToIssue(view, dir)
        view.focus()
      }
    }
  })
  if (settings.values.spell_check_enabled !== 'false') spell.schedule()
  markEditorReady()
})
onBeforeUnmount(() => {
  statsThrottle.cancel()
  spell.dispose()
  quranDetect.dispose()
  run.reset()
  editor.register(null)
  view?.destroy()
})
defineExpose({
  setText,
  loadSample,
  captureState,
  restoreState,
  /** actions the command registry drives (same as the toolbar buttons) */
  actions: {
    tashkeel: () => run.start(),
    proofreadThenTashkeel: () => run.proofreadThenStart(),
    paragraphRun,
    spellCheck: () => spell.checkNow(true),
    togglePageView,
    toggleReview,
    exportDocx,
    toggleTts: () => tts.toggle(editor.accessor?.getReadText() ?? ''),
    focus: () => view?.focus()
  }
})

const runBusy = computed(() => editor.runState === 'running' || editor.runState === 'waiting')
function startTashkeel(): void {
  if (runBusy.value) return void notify('التشكيل جارٍ بالفعل، انتظر حتى ينتهي.', { kind: 'info' })
  void run.start()
}
async function onLoadSample(): Promise<void> {
  await loadSample()
  notify('تم تحميل النص التجريبي في المحرر', { kind: 'success', ms: 2000 })
}
const spellBusy = ref(false)
async function runSpell(): Promise<void> {
  spellBusy.value = true
  try {
    await spell.checkNow(true)
    notify('اكتمل التدقيق الإملائي', { kind: 'success', ms: 1800 })
  } finally {
    spellBusy.value = false
  }
}

const selectCls = 'rounded border px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800'
const btnCls =
  'rounded border px-2 py-1 hover:bg-slate-200 dark:border-slate-600 dark:hover:bg-slate-700'
</script>

<template>
  <section
    id="editor-region"
    class="relative flex min-h-0 flex-1 flex-col"
    aria-label="مساحة التحرير"
    data-testid="editor"
  >
    <div
      class="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-1 text-xs dark:border-slate-700"
      role="toolbar"
      aria-label="أدوات المحرر"
      data-testid="editor-toolbar"
    >
      <button
        class="rounded bg-mizaj-emerald px-3 py-1 font-semibold text-white disabled:opacity-50"
        data-testid="toolbar-tashkeel"
        title="تشكيل المحدد أو كامل النص (Ctrl+Shift+T)"
        :aria-busy="editor.runState === 'running' || editor.runState === 'waiting'"
        :aria-disabled="editor.runState === 'running' || editor.runState === 'waiting' || undefined"
        @click="startTashkeel"
      >
        <span
          v-if="editor.runState === 'running' || editor.runState === 'waiting'"
          class="me-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent align-middle"
          aria-hidden="true"
          data-testid="tashkeel-spinner"
        />
        <AppIcon v-else name="tashkeel" :size="14" class="me-1 inline align-middle" />
        {{
          editor.runState === 'running' || editor.runState === 'waiting' ? 'جارٍ التشكيل…' : 'تشكيل'
        }}
      </button>
      <ToolbarToggle
        action
        icon="proofread"
        name="تدقيق ثم تشكيل"
        message="جارٍ التدقيق ثم التشكيل…"
        data-testid="toolbar-proofread"
        :disabled-reason="runBusy ? 'التشكيل جارٍ الآن، انتظر حتى ينتهي' : undefined"
        @click="run.proofreadThenStart()"
      >
        تدقيق ثم تشكيل
      </ToolbarToggle>
      <select
        :class="selectCls"
        :value="settings.values.engine_mode"
        aria-label="وضع المحرك"
        data-testid="toolbar-mode"
        @change="settings.update({ engine_mode: ($event.target as HTMLSelectElement).value })"
      >
        <option value="fast">سريع</option>
        <option
          value="accurate"
          :disabled="sidecar.accurateMissing"
          :title="
            sidecar.accurateMissing
              ? 'النموذج الدقيق غير متوفر. ثبّت حزمة النماذج من الإعدادات.'
              : ''
          "
        >
          دقيق
        </option>
      </select>
      <select
        :class="selectCls"
        :value="settings.values.tashkeel_level"
        aria-label="مستوى التشكيل"
        data-testid="toolbar-level"
        @change="settings.update({ tashkeel_level: ($event.target as HTMLSelectElement).value })"
      >
        <option value="full">كامل</option>
        <option value="irab_only">إعراب</option>
        <option value="essential">إلزامي: أواخر الكلمات والتنوين والشدة</option>
        <option value="minimal">أدنى</option>
        <option value="legal">قانوني (حيث يزيل اللبس)</option>
      </select>

      <ToolbarToggle
        :on="settings.colored"
        name="تلوين الحركات"
        icon="color"
        data-testid="color-toggle"
        @click="settings.update({ colored_diacritics: String(!settings.colored) })"
      >
        تلوين الحركات: {{ settings.colored ? 'مفعّل' : 'معطّل' }}
      </ToolbarToggle>
      <select
        :class="selectCls"
        :value="settings.values.diacritic_color"
        :disabled="!settings.colored"
        aria-label="لون الحركات"
        data-testid="color-choice"
        @change="settings.update({ diacritic_color: ($event.target as HTMLSelectElement).value })"
      >
        <option value="emerald">زمردي</option>
        <option value="amber">كهرماني</option>
      </select>

      <span class="mx-1 h-4 border-s dark:border-slate-600" />
      <ToolbarToggle
        :on="pageView"
        name="عرض الصفحة"
        icon="page"
        data-testid="toggle-page-view"
        :disabled-reason="projects.currentDocument ? undefined : 'افتح مستنداً أولاً'"
        @click="togglePageView"
      >
        {{ pageView ? 'تحرير النص' : 'عرض الصفحة' }}
      </ToolbarToggle>
      <template v-if="pageView">
        <button
          :class="btnCls"
          aria-label="تصغير"
          data-testid="page-zoom-out"
          @click="zoomPage(-10)"
        >
          −
        </button>
        <span class="tabular-nums" data-testid="page-zoom">{{ pageZoom }}%</span>
        <button :class="btnCls" aria-label="تكبير" data-testid="page-zoom-in" @click="zoomPage(10)">
          +
        </button>
      </template>
      <ToolbarToggle
        :on="editor.showDiff"
        name="مقارنة"
        icon="diff"
        data-testid="toggle-diff"
        :disabled-reason="
          editor.diffBase === null ? 'لا توجد نسخة سابقة للمقارنة؛ شكّل النص أولاً' : undefined
        "
        @click="editor.showDiff = !editor.showDiff"
      >
        مقارنة
      </ToolbarToggle>
      <ToolbarToggle
        :on="editor.showStats"
        name="إحصائيات"
        icon="stats"
        data-testid="toggle-stats"
        @click="editor.showStats = !editor.showStats"
      >
        إحصائيات
      </ToolbarToggle>
      <ToolbarToggle
        action
        icon="export"
        name="تصدير DOCX"
        message="جارٍ تجهيز ملف Word…"
        data-testid="export-docx"
        :disabled-reason="projects.currentDocument ? undefined : 'افتح مستنداً أولاً'"
        @click="exportDocx"
      >
        تصدير DOCX
      </ToolbarToggle>
      <ToolbarToggle
        action
        icon="tashkeel"
        name="تشكيل الفقرة"
        shortcut="Ctrl+Alt+T"
        message="جارٍ تشكيل الفقرة الحالية…"
        data-testid="toolbar-tashkeel-paragraph"
        @click="paragraphRun"
      >
        تشكيل الفقرة (مراجعة)
      </ToolbarToggle>
      <ToolbarToggle
        :on="editor.findOpen"
        name="بحث واستبدال"
        icon="find"
        shortcut="Ctrl+F"
        data-testid="toolbar-find"
        @click="editor.findOpen = !editor.findOpen"
      >
        بحث واستبدال
      </ToolbarToggle>
      <ToolbarToggle
        :on="tts.speaking.value"
        name="القراءة بصوت عالٍ"
        icon="read"
        data-testid="tts-read"
        @click="tts.toggle(editor.accessor?.getReadText() ?? '')"
      >
        {{ tts.speaking.value ? 'إيقاف القراءة' : 'قراءة بصوت عالٍ' }}
      </ToolbarToggle>
      <ToolbarToggle
        :on="quality.review.active"
        name="وضع المراجعة"
        icon="review"
        shortcut="F7"
        data-testid="toolbar-review"
        @click="toggleReview"
      >
        وضع المراجعة
      </ToolbarToggle>
      <ToolbarToggle
        action
        icon="normalize"
        name="توحيد النص"
        message="فُتحت نافذة توحيد النص"
        data-testid="toolbar-normalize"
        @click="quality.normalizeOpen = true"
      >
        توحيد النص
      </ToolbarToggle>
      <ToolbarToggle
        :on="quality.poetryOn"
        name="وضع الشعر"
        icon="poetry"
        data-testid="poetry-toggle"
        :disabled-reason="projects.currentDocument ? undefined : 'افتح مستنداً أولاً'"
        @click="quality.setPoetry(!quality.poetryOn)"
      >
        وضع الشعر
      </ToolbarToggle>
      <ToolbarToggle
        panel
        :on="editor.rightPanel === 'quality'"
        name="جودة التحرير"
        icon="quality"
        shortcut="Esc للإغلاق"
        data-testid="toggle-quality-panel"
        @click="editor.rightPanel = editor.rightPanel === 'quality' ? null : 'quality'"
      >
        جودة التحرير
      </ToolbarToggle>
      <ToolbarToggle
        panel
        :on="editor.rightPanel === 'poetry'"
        name="تحليل البحر"
        icon="poetry"
        shortcut="Esc للإغلاق"
        data-testid="toggle-poetry-panel"
        @click="editor.rightPanel = editor.rightPanel === 'poetry' ? null : 'poetry'"
      >
        تحليل البحر
      </ToolbarToggle>
      <ToolbarToggle
        action
        quiet
        icon="spell"
        name="تدقيق إملائي"
        shortcut="Ctrl+Shift+L"
        :busy="spellBusy"
        :disabled-reason="spellBusy ? 'التدقيق جارٍ الآن' : undefined"
        data-testid="toolbar-spell"
        @click="runSpell"
      >
        {{ spellBusy ? 'جارٍ التدقيق…' : 'تدقيق إملائي' }}
      </ToolbarToggle>
      <ToolbarToggle
        panel
        :on="editor.rightPanel === 'spelling'"
        name="قائمة الأخطاء"
        icon="list"
        shortcut="Esc للإغلاق"
        data-testid="toggle-spell-panel"
        @click="editor.rightPanel = editor.rightPanel === 'spelling' ? null : 'spelling'"
      >
        قائمة الأخطاء
      </ToolbarToggle>
      <ToolbarToggle
        v-if="gemini.enabled"
        panel
        :on="editor.rightPanel === 'gemini'"
        name="اسأل عن المستند"
        icon="gemini"
        shortcut="Esc للإغلاق"
        data-testid="toggle-gemini-panel"
        @click="editor.rightPanel = editor.rightPanel === 'gemini' ? null : 'gemini'"
      >
        اسأل عن المستند
      </ToolbarToggle>
      <ToolbarToggle
        panel
        :on="editor.rightPanel === 'legal'"
        name="أدوات قانونية"
        icon="legal"
        shortcut="Esc للإغلاق"
        data-testid="toggle-legal-panel"
        @click="editor.rightPanel = editor.rightPanel === 'legal' ? null : 'legal'"
      >
        أدوات قانونية
      </ToolbarToggle>
      <button
        class="rounded bg-mizaj-amber/20 px-2 py-1 text-mizaj-amber hover:bg-mizaj-amber/30"
        data-testid="load-sample"
        title="تحميل نص تجريبي طويل لتجربة التشكيل"
        @click="onLoadSample"
      >
        <AppIcon name="sample" :size="14" class="me-1 inline align-middle" />
        تحميل النص التجريبي
      </button>
    </div>
    <ReviewBar
      @step="(d) => view && reviewStep(quals.confidence, view, d)"
      @keep="view && reviewKeep(quals.confidence, view)"
      @inspect="view && openInspectorAt(view)"
    />
    <div
      v-if="quality.quranInstalled === false && !quality.quranHintDismissed && !quranHintHidden"
      class="flex items-center gap-3 border-b border-blue-400/40 bg-blue-500/10 px-3 py-1 text-xs"
      role="status"
      data-testid="quran-hint"
    >
      <span
        >نص القرآن غير مثبّت، لذلك لا تُحمى الآيات من التعديل ولا تُكتشف. يمكنك تثبيته من
        الإعدادات.</span
      >
      <button
        class="rounded bg-blue-600 px-2 py-0.5 text-white"
        data-testid="quran-hint-open"
        @click="quality.openSettings('quran')"
      >
        فتح الإعدادات
      </button>
      <button
        class="rounded border px-2 py-0.5"
        data-testid="quran-hint-dismiss"
        @click="dismissQuranHint"
      >
        لا تُظهر مرة أخرى
      </button>
    </div>
    <FindBar />
    <div
      v-if="editor.pendingCount > 0"
      class="flex items-center gap-3 border-b border-mizaj-emerald/40 bg-mizaj-emerald/10 px-3 py-1 text-xs"
      role="status"
      data-testid="pending-bar"
    >
      <span>{{ editor.pendingCount }} فقرة بانتظار المراجعة</span>
      <button
        class="rounded bg-mizaj-emerald px-2 py-0.5 text-white"
        data-testid="pending-accept-all"
        @click="view && acceptAll(view)"
      >
        قبول الكل
      </button>
      <button
        class="rounded border px-2 py-0.5"
        data-testid="pending-reject-all"
        @click="view && rejectAll(view)"
      >
        رفض الكل
      </button>
    </div>
    <div
      v-if="editor.longestLine > LONG_LINE_THRESHOLD"
      class="flex items-center gap-3 border-b border-mizaj-amber/40 bg-mizaj-amber/10 px-3 py-1 text-xs"
      role="status"
      data-testid="long-line-banner"
    >
      <span
        >يحتوي المستند فقرة طويلة جداً ({{ editor.longestLine }} حرف) قد تُبطئ التشكيل
        والتراجع.</span
      >
      <button
        class="rounded bg-mizaj-amber px-2 py-0.5 text-black"
        data-testid="split-long-lines"
        @click="splitLongLines"
      >
        تقسيم الفقرات الطويلة عند الجمل
      </button>
    </div>
    <EnginePill />
    <StatsPanel v-if="editor.showStats" />
    <ProgressBar @pause="run.pause()" @resume="run.resume()" @cancel="run.cancel()" />
    <DiffView v-if="editor.showDiff && editor.diffBase !== null" />
    <PageView
      v-if="pageView && projects.currentDocument"
      :document-id="projects.currentDocument.id"
      :diacritized="!!editor.diacritizedDocs[projects.currentDocument.id]"
      :tick="pageTick"
      :zoom="pageZoom"
      :before-render="props.flushSave"
    />
    <div
      v-show="!pageView && !(editor.showDiff && editor.diffBase !== null)"
      ref="host"
      class="mizaj-editor min-h-0 flex-1"
      :class="[paletteClass, quality.confidenceShow ? '' : 'conf-off']"
      data-testid="editor-host"
    />
    <MotionTransition name="m-modal">
      <NormalizeDialog v-if="quality.normalizeOpen" />
    </MotionTransition>
    <DropOverlay @open="openAndMaybeDiacritize" />
  </section>
</template>
