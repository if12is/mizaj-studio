<script setup lang="ts">
/**
 * Print preview (Ctrl+P). The page-view rendering of the document is laid out on fixed-size
 * sheets with a header (title + optional case data) and «صفحة ١ من ٥»; what is shown here is
 * exactly what «طباعة» / «حفظ PDF» send to the print window (src/main/print.ts).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'
import { toArabicIndic } from '@renderer/lib/arabicDigits'
import { buildSheets, type CaseData, type PageSize } from '@renderer/print/sheets'
import '@renderer/print/print.css'
import { useEditorStore } from '@renderer/stores/editor'
import { useExtrasStore } from '@renderer/stores/extras'
import { useProjectsStore } from '@renderer/stores/projects'

const props = defineProps<{ flush: () => Promise<void> }>()
const extras = useExtrasStore()
const projects = useProjectsStore()
const editor = useEditorStore()

interface RenderResult {
  html: string
  page: PageSize
}

const el = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref('')
const busy = ref(false)
const pages = ref(0)
const zoom = ref(0.6)
useFocusTrap(el, () => close())

const doc = projects.currentDocument
const title = ref(doc?.title ?? '')
const useCase = ref(false)
const caseData = reactive<CaseData>({ number: '', court: '', parties: '' })
const KEY = `mizaj.print.case.${doc?.id ?? 0}`
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as
    | (CaseData & { on?: boolean })
    | null
  if (saved) {
    useCase.value = !!saved.on
    caseData.number = saved.number ?? ''
    caseData.court = saved.court ?? ''
    caseData.parties = saved.parties ?? ''
  }
} catch {
  /* nothing remembered */
}
/** Fill the case fields from the document with the legal «بطاقة القضية» extractor (suggestion; editable). */
async function fillFromDocument(): Promise<void> {
  try {
    const r = await useApi().post<{ fields: { key: string; value: string }[] }>(
      '/api/legal/case-card',
      { text: editor.accessor?.getText() ?? '' }
    )
    const by = Object.fromEntries(r.fields.map((f) => [f.key, f.value]))
    if (by.case_number) caseData.number = by.case_number
    if (by.court) caseData.court = by.court
    if (by.parties) caseData.parties = by.parties
    if (!r.fields.length) notify('لم يُعثر على بيانات قضية في النص.', { kind: 'info' })
  } catch {
    /* error toast shown by the api client */
  }
}
function rememberCase(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ on: useCase.value, ...caseData }))
  } catch {
    /* storage unavailable */
  }
}

let source: RenderResult | null = null
let sheetsHtml = ''
let seq = 0
async function layout(): Promise<void> {
  if (!source) return
  const my = ++seq
  const { root, pages: n } = await buildSheets(source.html, source.page, {
    title: title.value.trim() || doc?.title || '',
    caseData: useCase.value ? { ...caseData } : null
  })
  if (my !== seq) return
  pages.value = n
  sheetsHtml = root.outerHTML
  await nextTick()
  stage.value?.replaceChildren(root)
}

async function load(): Promise<void> {
  if (!doc) return
  try {
    await props.flush() // print what is on screen, not the last autosave
    source = await useApi().post<RenderResult>('/api/docx/render', {
      document_id: doc.id,
      diacritized: !!editor.diacritizedDocs[doc.id]
    })
    await layout()
  } catch {
    error.value = 'تعذّر تجهيز المستند للطباعة.'
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
watch([title, useCase, () => caseData.number, () => caseData.court, () => caseData.parties], () => {
  rememberCase()
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void layout(), 250)
})
onMounted(() => void load())
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  seq++
})

function close(): void {
  extras.printOpen = false
}
const sizeOf = (): PageSize => source?.page ?? { width_pt: 595.3, height_pt: 841.9 }

async function send(mode: 'print' | 'pdf'): Promise<void> {
  const api = window.mizajAPI
  if (!api || !sheetsHtml || busy.value) return
  busy.value = true
  try {
    let targetPath: string | undefined
    if (mode === 'pdf') {
      const p = await api.showSaveFileDialog({
        defaultName: `${(title.value.trim() || 'مستند').slice(0, 120)}.pdf`,
        extensions: ['pdf'],
        filterName: 'PDF'
      })
      if (!p) return
      targetPath = p
    }
    const r = await api.printSheets({
      html: sheetsHtml,
      widthPt: sizeOf().width_pt,
      heightPt: sizeOf().height_pt,
      pages: pages.value,
      mode,
      targetPath
    })
    if (!r.ok) return void notify(`تعذرت العملية: ${r.error}`)
    if (mode === 'pdf') {
      notify(`تم حفظ ملف PDF (${toArabicIndic(r.pages)} صفحة).`, { kind: 'success' })
      close()
    }
  } finally {
    busy.value = false
  }
}

const pagesText = computed(() =>
  pages.value === 1
    ? 'صفحة واحدة'
    : pages.value === 2
      ? 'صفحتان'
      : `${toArabicIndic(pages.value)} ${pages.value <= 10 ? 'صفحات' : 'صفحة'}`
)
const field =
  'w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100'
const btn =
  'rounded-md border px-3 py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-mizaj-emerald disabled:opacity-50'
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" @click.self="close">
    <div
      ref="el"
      class="flex h-[92vh] w-[70rem] max-w-[96vw] flex-col rounded-lg bg-white text-slate-900 shadow-2xl dark:bg-slate-800 dark:text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="معاينة الطباعة"
      dir="rtl"
      data-testid="print-preview"
    >
      <div
        class="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-700"
      >
        <h2 class="text-lg font-bold">معاينة الطباعة</h2>
        <span class="text-sm text-slate-600 dark:text-slate-300" data-testid="print-pages">{{
          loading ? 'جارٍ التجهيز…' : pagesText
        }}</span>
        <button
          class="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-700"
          aria-label="إغلاق"
          data-testid="print-close"
          @click="close"
        >
          ✕
        </button>
      </div>
      <div class="flex min-h-0 flex-1">
        <aside
          class="w-64 shrink-0 space-y-3 overflow-auto border-e border-slate-200 p-3 text-sm dark:border-slate-700"
        >
          <label class="block">
            <span class="mb-1 block font-semibold">عنوان الترويسة</span>
            <input v-model="title" :class="field" data-testid="print-title" />
          </label>
          <label class="flex items-center gap-2">
            <input v-model="useCase" type="checkbox" data-testid="print-case-toggle" />
            <span>إضافة بيانات القضية إلى الترويسة</span>
          </label>
          <div v-if="useCase" class="space-y-2">
            <button
              class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-500 dark:hover:bg-slate-700"
              data-testid="print-case-fill"
              @click="fillFromDocument"
            >
              استخراج من نص المستند
            </button>
            <label class="block">
              <span class="mb-1 block">رقم القضية</span>
              <input v-model="caseData.number" :class="field" data-testid="print-case-number" />
            </label>
            <label class="block">
              <span class="mb-1 block">المحكمة</span>
              <input v-model="caseData.court" :class="field" data-testid="print-case-court" />
            </label>
            <label class="block">
              <span class="mb-1 block">الأطراف</span>
              <input v-model="caseData.parties" :class="field" data-testid="print-case-parties" />
            </label>
          </div>
          <label class="block">
            <span class="mb-1 block">تكبير المعاينة</span>
            <input
              v-model.number="zoom"
              type="range"
              min="0.3"
              max="1.2"
              step="0.05"
              class="w-full"
              aria-label="تكبير المعاينة"
            />
          </label>
          <p class="text-xs text-slate-600 dark:text-slate-300">
            ترقيم الصفحات بالأرقام الهندية، والمعاينة هي نفسها ما يُطبع.
          </p>
        </aside>
        <div class="min-w-0 flex-1 overflow-auto bg-slate-500 p-4 dark:bg-slate-900">
          <p
            v-if="error"
            class="rounded bg-red-100 p-3 text-red-900"
            role="alert"
            data-testid="print-error"
          >
            {{ error }}
          </p>
          <div class="flex min-w-max justify-center" :style="{ zoom }">
            <div ref="stage" data-testid="print-stage" />
          </div>
        </div>
      </div>
      <div
        class="flex items-center gap-2 border-t border-slate-200 px-4 py-2 dark:border-slate-700"
      >
        <button
          :class="[btn, 'border-emerald-800 bg-emerald-700 text-white hover:bg-emerald-800']"
          :disabled="loading || busy || !pages"
          data-testid="print-run"
          @click="send('print')"
        >
          طباعة
        </button>
        <button
          :class="[
            btn,
            'border-slate-300 hover:bg-slate-100 dark:border-slate-500 dark:hover:bg-slate-700'
          ]"
          :disabled="loading || busy || !pages"
          data-testid="print-pdf"
          @click="send('pdf')"
        >
          حفظ PDF
        </button>
        <span class="flex-1" />
        <button
          :class="[
            btn,
            'border-slate-300 hover:bg-slate-100 dark:border-slate-500 dark:hover:bg-slate-700'
          ]"
          data-testid="print-cancel"
          @click="close"
        >
          إغلاق
        </button>
      </div>
    </div>
  </div>
</template>
