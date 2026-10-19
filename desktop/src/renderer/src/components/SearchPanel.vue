<script setup lang="ts">
/**
 * «بحث في كل الملفات» (Ctrl+Shift+F): full-text search over every document through the backend
 * FTS index (diacritics, tatweel and hamza/ya/ta-marbuta variants are ignored). Results are
 * grouped by document; a click opens the document with the cursor on the match.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'
import { relativeTimeAr } from '@renderer/lib/relativeTime'
import {
  highlightParts,
  MIN_QUERY,
  searchContent,
  type ContentResponse,
  type ContentResult,
  type ContentSnippet
} from '@renderer/search/content'
import { openAtMatch } from '@renderer/search/openAt'
import { useExtrasStore } from '@renderer/stores/extras'

const props = defineProps<{ openDocument: (id: number) => void | Promise<void> }>()
const extras = useExtrasStore()

const el = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const query = ref(extras.searchSeed)
const data = ref<ContentResponse | null>(null)
const loading = ref(false)
const failed = ref(false)
const tooShort = computed(() => query.value.trim().length < MIN_QUERY)
useFocusTrap(el, () => close())

function close(): void {
  extras.searchOpen = false
}

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
async function run(): Promise<void> {
  const q = query.value.trim()
  const my = ++seq
  if (q.length < MIN_QUERY) {
    data.value = null
    loading.value = false
    failed.value = false
    return
  }
  loading.value = true
  try {
    const r = await searchContent(q, { limit: 40, snippets: 4 })
    if (my !== seq) return
    data.value = r
    failed.value = false
  } catch {
    if (my === seq) failed.value = true
  } finally {
    if (my === seq) loading.value = false
  }
}
watch(query, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void run(), 200)
})
onMounted(() => {
  input.value?.focus()
  input.value?.select()
  if (!tooShort.value) void run()
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  seq++
})

const results = computed<ContentResult[]>(() => data.value?.results ?? [])
const hitCount = computed(() => results.value.reduce((n, r) => n + r.match_count, 0))

function hits(): HTMLElement[] {
  return [...(listEl.value?.querySelectorAll<HTMLElement>('[data-hit]') ?? [])]
}
function onInputKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    hits()[0]?.focus()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (timer) clearTimeout(timer)
    void run().then(() => nextTick(() => hits()[0]?.focus()))
  }
}
function onListKey(e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const list = hits()
  const i = list.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowUp' && i <= 0) return input.value?.focus()
  list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
}

function open(r: ContentResult, s?: ContentSnippet): void {
  const first = s ?? r.snippets[0]
  const len = first && first.ranges[0] ? first.ranges[0][1] - first.ranges[0][0] : 0
  close()
  // after the dialog is gone and focus is restored, so the editor can take focus itself
  setTimeout(() => void openAtMatch(props.openDocument, r.document_id, first?.offset ?? 0, len), 0)
}
const ago = (iso: string): string => relativeTimeAr(Date.parse(iso) || Date.now())
</script>

<template>
  <div
    class="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-3 pt-[10vh]"
    data-testid="search-backdrop"
    @mousedown.self="close"
  >
    <div
      ref="el"
      class="flex max-h-[76vh] w-[46rem] max-w-full flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-900 shadow-2xl dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="بحث في كل الملفات"
      dir="rtl"
      data-testid="search-panel"
    >
      <div
        class="flex items-center gap-2 border-b border-slate-200 px-4 py-2 dark:border-slate-700"
      >
        <h2 class="shrink-0 text-sm font-bold">بحث في كل الملفات</h2>
        <input
          ref="input"
          v-model="query"
          type="search"
          class="min-w-0 flex-1 rounded border border-slate-300 bg-white px-3 py-1.5 text-base outline-none focus:border-mizaj-emerald dark:border-slate-600 dark:bg-slate-900"
          placeholder="ابحث في محتوى كل المستندات…"
          aria-label="نص البحث"
          autocomplete="off"
          spellcheck="false"
          data-testid="search-input"
          @keydown="onInputKey"
        />
        <button
          class="rounded px-2 py-1 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
          aria-label="إغلاق"
          data-testid="search-close"
          @click="close"
        >
          ✕
        </button>
      </div>
      <p class="px-4 pt-2 text-xs text-slate-600 dark:text-slate-300" data-testid="search-hint">
        يتجاهل البحث التشكيل والتطويل والفروق بين الهمزات والألف، وبين الياء والألف المقصورة، وبين
        التاء المربوطة والهاء.
      </p>
      <div
        ref="listEl"
        class="min-h-0 flex-1 overflow-auto px-2 py-2"
        role="region"
        aria-label="النتائج"
        aria-live="polite"
        data-testid="search-results"
        @keydown="onListKey"
      >
        <p v-if="tooShort" class="px-3 py-6 text-center text-sm text-slate-600 dark:text-slate-300">
          اكتب حرفين على الأقل للبحث.
        </p>
        <p
          v-else-if="failed"
          class="px-3 py-6 text-center text-sm text-red-700 dark:text-red-300"
          data-testid="search-error"
        >
          تعذّر البحث الآن. تأكد أن المحرك جاهز ثم أعد المحاولة.
        </p>
        <p
          v-else-if="data && !results.length"
          class="px-3 py-6 text-center text-sm text-slate-600 dark:text-slate-300"
          data-testid="search-empty"
        >
          لا توجد نتائج في أي مستند.
        </p>
        <p
          v-else-if="loading && !data"
          class="px-3 py-6 text-center text-sm text-slate-600 dark:text-slate-300"
          role="status"
        >
          جارٍ البحث…
        </p>
        <template v-if="!tooShort && results.length">
          <p
            class="px-3 pb-1 text-xs text-slate-600 dark:text-slate-300"
            data-testid="search-count"
          >
            {{ results.length }} مستند · {{ hitCount }} نتيجة
          </p>
          <section
            v-for="r in results"
            :key="r.document_id"
            class="mb-2 rounded-md border border-slate-200 dark:border-slate-700"
            data-testid="search-result"
            :data-document="r.document_id"
          >
            <button
              class="flex w-full items-baseline justify-between gap-3 rounded-t-md bg-slate-50 px-3 py-1.5 text-start hover:bg-slate-100 dark:bg-slate-900/50 dark:hover:bg-slate-900"
              data-hit
              data-testid="search-doc"
              @click="open(r)"
            >
              <span class="min-w-0 truncate font-semibold">
                <template v-for="(p, i) in highlightParts(r.title, r.title_ranges)" :key="i">
                  <mark v-if="p.mark" class="search-mark">{{ p.text }}</mark>
                  <template v-else>{{ p.text }}</template>
                </template>
              </span>
              <span class="shrink-0 text-xs text-slate-600 dark:text-slate-300">
                {{ r.project_name }} · {{ ago(r.updated_at) }}
              </span>
            </button>
            <button
              v-for="(s, i) in r.snippets"
              :key="i"
              class="block w-full border-t border-slate-100 px-3 py-1.5 text-start font-editor text-base leading-relaxed hover:bg-mizaj-emerald/10 dark:border-slate-700/60 dark:hover:bg-mizaj-emerald/20"
              data-hit
              data-testid="search-hit"
              @click="open(r, s)"
            >
              <template v-for="(p, j) in highlightParts(s.text, s.ranges)" :key="j">
                <mark v-if="p.mark" class="search-mark">{{ p.text }}</mark>
                <template v-else>{{ p.text }}</template>
              </template>
            </button>
          </section>
        </template>
      </div>
      <div
        class="flex gap-4 border-t border-slate-200 px-4 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300"
      >
        <span>↑↓ تنقّل</span>
        <span>Enter فتح</span>
        <span>Esc إغلاق</span>
      </div>
    </div>
  </div>
</template>
