<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import sampleText from '@fixtures/sample_long.txt?raw'
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
import DiffView from './DiffView.vue'
import DropOverlay from './DropOverlay.vue'
import ProgressBar from './ProgressBar.vue'
import StatsPanel from './StatsPanel.vue'
import { useSpellCheck } from '@renderer/composables/useSpellCheck'
import { useSpellingStore } from '@renderer/stores/spelling'
import { createThrottle as throttle2 } from '@renderer/composables/throttle'
import { insertAtCursorSpec, safeEditSpec } from '@renderer/editor/safeEdit'
import { goToIssue } from '@renderer/editor/spelling'

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

const spell = useSpellCheck(() => view)
const spelling = useSpellingStore()
let pendingMarks: import('@renderer/editor/spellModel').SpellMark[] | null = null
const flushMarks = throttle2(() => {
  if (pendingMarks) spelling.marks = pendingMarks
}, 300)

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
      inspector: {
        fetchSuggestions,
        saveToDictionary,
        onManualEdit: (n, w) => editor.addManualEdits(projects.currentDocument?.id ?? 0, n, w)
      }
    }),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    readOnlyCompartment.of(EditorState.readOnly.of(false)),
    EditorView.lineWrapping,
    EditorView.perLineTextDirection.of(true),
    EditorView.contentAttributes.of({ dir: 'rtl', lang: 'ar', 'data-testid': 'editor-content' }),
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) {
        editor.cursorLine = u.state.doc.lineAt(u.state.selection.main.head).number
      }
      if (u.docChanged) {
        scheduleStats()
        if (!silent) emit('change')
      }
      if (u.docChanged || u.viewportChanged) spell.schedule()
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
  editor.diffBase = null
  editor.showDiff = false
  refreshStats()
  if (notifyChange) emit('change')
}

function loadSample(): void {
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
    jumpTo: (from, to) => {
      if (!view) return
      const len = view.state.doc.length
      view.dispatch({
        selection: { anchor: Math.min(from, len), head: Math.min(to, len) },
        effects: EditorView.scrollIntoView(Math.min(from, len), { y: 'center' })
      })
      view.focus()
    },
    spellNav: (dir) => {
      if (view) {
        goToIssue(view, dir)
        view.focus()
      }
    }
  })
  if (settings.values.spell_check_enabled !== 'false') spell.schedule()
})
onBeforeUnmount(() => {
  statsThrottle.cancel()
  spell.dispose()
  run.reset()
  editor.register(null)
  view?.destroy()
})
defineExpose({ setText, loadSample })

const selectCls = 'rounded border px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800'
const btnCls =
  'rounded border px-2 py-1 hover:bg-slate-200 dark:border-slate-600 dark:hover:bg-slate-700'
</script>

<template>
  <section class="relative flex min-h-0 flex-1 flex-col" data-testid="editor">
    <div
      class="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-1 text-xs dark:border-slate-700"
      data-testid="editor-toolbar"
    >
      <button
        class="rounded bg-mizaj-emerald px-3 py-1 font-semibold text-white disabled:opacity-50"
        data-testid="toolbar-tashkeel"
        :disabled="editor.runState === 'running' || editor.runState === 'waiting'"
        title="Ctrl+Shift+T"
        @click="run.start()"
      >
        تشكيل
      </button>
      <select
        :class="selectCls"
        :value="settings.values.engine_mode"
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
        data-testid="toolbar-level"
        @change="settings.update({ tashkeel_level: ($event.target as HTMLSelectElement).value })"
      >
        <option value="full">كامل</option>
        <option value="irab_only">إعراب</option>
        <option value="minimal">أدنى</option>
        <option value="legal">قانوني (حيث يزيل اللبس)</option>
      </select>

      <button
        :class="[btnCls, settings.colored ? 'border-mizaj-emerald' : '']"
        data-testid="color-toggle"
        :aria-pressed="settings.colored"
        @click="settings.update({ colored_diacritics: String(!settings.colored) })"
      >
        تلوين الحركات: {{ settings.colored ? 'مفعّل' : 'معطّل' }}
      </button>
      <select
        :class="selectCls"
        :value="settings.values.diacritic_color"
        :disabled="!settings.colored"
        data-testid="color-choice"
        @change="settings.update({ diacritic_color: ($event.target as HTMLSelectElement).value })"
      >
        <option value="emerald">زمردي</option>
        <option value="amber">كهرماني</option>
      </select>

      <span class="mx-1 h-4 border-s dark:border-slate-600" />
      <button
        :class="btnCls"
        data-testid="toggle-diff"
        :disabled="editor.diffBase === null"
        @click="editor.showDiff = !editor.showDiff"
      >
        مقارنة
      </button>
      <button
        :class="btnCls"
        data-testid="toggle-stats"
        @click="editor.showStats = !editor.showStats"
      >
        إحصائيات
      </button>
      <button
        :class="btnCls"
        data-testid="export-docx"
        :disabled="!projects.currentDocument"
        @click="exportDocx"
      >
        تصدير DOCX
      </button>
      <button
        :class="btnCls"
        data-testid="toolbar-spell"
        title="Ctrl+Shift+L"
        @click="spell.checkNow(true)"
      >
        تدقيق إملائي
      </button>
      <button
        :class="[btnCls, editor.rightPanel === 'spelling' ? 'border-mizaj-emerald' : '']"
        data-testid="toggle-spell-panel"
        @click="editor.rightPanel = editor.rightPanel === 'spelling' ? null : 'spelling'"
      >
        قائمة الأخطاء
      </button>
      <button
        :class="[btnCls, editor.rightPanel === 'legal' ? 'border-mizaj-emerald' : '']"
        data-testid="toggle-legal-panel"
        @click="editor.rightPanel = editor.rightPanel === 'legal' ? null : 'legal'"
      >
        أدوات قانونية
      </button>
      <button
        class="rounded bg-mizaj-amber/20 px-2 py-1 text-mizaj-amber hover:bg-mizaj-amber/30"
        data-testid="load-sample"
        @click="loadSample"
      >
        تحميل النص التجريبي
      </button>
    </div>
    <StatsPanel v-if="editor.showStats" />
    <ProgressBar @pause="run.pause()" @resume="run.resume()" @cancel="run.cancel()" />
    <DiffView v-if="editor.showDiff && editor.diffBase !== null" />
    <div
      v-show="!(editor.showDiff && editor.diffBase !== null)"
      ref="host"
      class="mizaj-editor min-h-0 flex-1"
      :class="paletteClass"
      data-testid="editor-host"
    />
    <DropOverlay @open="openAndMaybeDiacritize" />
  </section>
</template>
