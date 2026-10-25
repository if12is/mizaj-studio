<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useEditorStore } from '@renderer/stores/editor'
import { useGeminiStore } from '@renderer/stores/gemini'
import { useQualityStore } from '@renderer/stores/quality'
import { useProjectsStore } from '@renderer/stores/projects'
import { diffMarkEdits } from '@renderer/editor/markEdits'
import { stripMarks } from '@renderer/editor/arabic'
import { notify } from '@renderer/api/toast'
import { recordEvent } from '@renderer/stores/history'
import { EVENT_LABELS } from '@renderer/history/logic'
import { hideSuggestionFence, renderMarkdown } from '@renderer/lib/safeMarkdown'

type Req = Parameters<ReturnType<typeof useGeminiStore>['ask']>[0]

interface Turn {
  id: number
  /** the document (tab) the question was asked about; turns of other tabs are hidden */
  docId: number
  scope: 'doc' | 'selection'
  question: string
  answer: string | null
  error: string | null
  truncated: boolean
  cutoff: boolean
  /** seconds left before the automatic quota retry */
  countdown: number | null
  req: Req | null
  suggestion: string | null
  /** selection the suggestion refers to (apply is offered only if its base letters are identical) */
  sel: { from: number; to: number; text: string } | null
  applied: boolean
  /** the document text changed since the previous question: context was re-sent */
  refreshed: boolean
  /** request in flight (waiting for the first token or receiving text) */
  streaming: boolean
  streamId: string | null
  /** seconds since the request started (shown while «يفكّر…») */
  elapsed: number
  /** the user pressed «إيقاف» */
  stopped: boolean
  usage: GeminiUsageDto | null
}

const editor = useEditorStore()
const gemini = useGeminiStore()
const quality = useQualityStore()
const projects = useProjectsStore()
const docId = computed(() => projects.currentDocument?.id ?? null)
/** this document has a saved conversation (its text sits once in the chat context) */
const saved = ref(false)
const staleOnLoad = ref(false)
const question = ref('')
const scope = ref<'doc' | 'selection'>('doc')
const allTurns = ref<Turn[]>([])
// each document (tab) has its own conversation: the panel only shows the active tab's turns
const turns = computed(() =>
  allTurns.value.filter((t) => t.docId === (projects.currentDocument?.id ?? 0))
)
const busy = ref(false)
const list = ref<HTMLElement | null>(null)
let seq = 0

const canAsk = computed(() => gemini.ready && !busy.value && question.value.trim().length > 0)

const canApply = (t: Turn): boolean =>
  !!t.suggestion && !!t.sel && !t.applied && stripMarks(t.sel.text) === stripMarks(t.suggestion)

async function send(): Promise<void> {
  const q = question.value.trim()
  const acc = editor.accessor
  if (!q || !acc) return
  const turn: Turn = {
    id: ++seq,
    docId: projects.currentDocument?.id ?? 0,
    scope: scope.value,
    question: q,
    answer: null,
    error: null,
    truncated: false,
    cutoff: false,
    countdown: null,
    req: null,
    suggestion: null,
    sel: null,
    applied: false,
    refreshed: false,
    streaming: false,
    streamId: null,
    elapsed: 0,
    stopped: false,
    usage: null
  }
  let req: Parameters<typeof gemini.ask>[0]
  if (scope.value === 'selection') {
    const s = acc.selectionInfo()
    const hasSel = s.to > s.from
    if (!hasSel) {
      allTurns.value.push({ ...turn, error: 'حدّد نصاً في المحرر أولاً، أو اختر «المستند كله».' })
      return
    }
    turn.sel = s
    req = {
      kind: 'selection',
      question: q,
      text: s.text,
      context: sentenceAround(acc.getText(), s),
      ...(docId.value ? { docId: docId.value, docText: acc.getText() } : {})
    }
  } else
    req = {
      kind: 'document',
      question: q,
      text: acc.getText(),
      ...(docId.value ? { docId: docId.value } : {})
    }
  turn.req = req
  allTurns.value.push(turn)
  question.value = ''
  await run(turn.id, req, false)
}

/** The sentence containing the selection (context for word questions). */
function sentenceAround(
  doc: string,
  s: { from: number; to: number; text: string }
): string | undefined {
  if (doc.slice(s.from, s.to) !== s.text) return undefined
  const stop = /[.!؟?؛\n]/
  let a = s.from
  while (a > 0 && !stop.test(doc[a - 1])) a--
  let b = s.to
  while (b < doc.length && !stop.test(doc[b])) b++
  const sent = doc.slice(a, Math.min(b + 1, doc.length)).trim()
  return sent && sent.length <= 2000 ? sent : undefined
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** shown answer: while streaming the machine-readable suggestion block is hidden */
const shown = (t: Turn): string =>
  t.streaming && t.answer !== null ? hideSuggestionFence(t.answer) : t.answer ?? ''

function stop(t: Turn): void {
  if (!t.streamId || !t.streaming) return
  t.stopped = true
  gemini.cancel(t.streamId)
}

function scrollIfNearBottom(): void {
  const el = list.value
  if (!el || el.scrollHeight - el.scrollTop - el.clientHeight > 120) return
  void nextTick(() => el.scrollTo({ top: el.scrollHeight }))
}

async function run(id: number, req: Req, cont: boolean, retried = false): Promise<void> {
  busy.value = true
  const t = allTurns.value.find((x) => x.id === id)!
  const prior = cont ? t.answer ?? '' : ''
  const sep = /\s$/.test(prior) || !prior ? '' : ' '
  let acc = ''
  const started = Date.now()
  t.streaming = true
  t.stopped = false
  t.elapsed = 0
  t.error = null
  const timer = setInterval(() => (t.elapsed = Math.floor((Date.now() - started) / 1000)), 1000)
  try {
    const r = await gemini.ask(cont ? ({ ...req, continueFrom: prior } as Req) : req, {
      onStart: (sid) => (t.streamId = sid),
      onDelta: (d) => {
        acc += d
        if (acc.trim()) t.answer = cont ? `${prior}${sep}${acc}` : acc
        scrollIfNearBottom()
      }
    })
    t.streaming = false
    if (r.ok) {
      t.error = null
      t.answer = cont ? `${prior}${sep}${r.text}` : r.text || '(لا نص)'
      t.truncated = r.truncated
      if (r.contextRefreshed) t.refreshed = true
      if (docId.value) {
        saved.value = true
        staleOnLoad.value = false
      }
      t.cutoff = r.cutoff
      t.usage = r.usage
      if (!cont) t.suggestion = r.suggestion
    } else if (r.code === 'aborted') {
      // stopped by the user: keep what already arrived
      t.stopped = true
      if (t.answer !== null) t.answer = hideSuggestionFence(t.answer)
    } else if (r.retryAfterSec !== null && r.retryAfterSec <= 30 && !retried) {
      // quota with a short wait: count down, then retry once automatically
      for (let left = Math.ceil(r.retryAfterSec) + 1; left > 0; left--) {
        t.countdown = left
        await sleep(1000)
      }
      t.countdown = null
      clearInterval(timer)
      await run(id, req, cont, true)
      return
    } else {
      t.error = r.message
      if (t.answer !== null && !cont) t.answer = hideSuggestionFence(t.answer)
    }
  } finally {
    clearInterval(timer)
    t.streaming = false
    busy.value = false
    await nextTick()
    list.value?.scrollTo({ top: list.value.scrollHeight })
  }
}

/** Restore the persisted conversation of the open document (history lives in the main process). */
async function loadSession(): Promise<void> {
  saved.value = false
  staleOnLoad.value = false
  const id = docId.value
  if (!id || !gemini.ready) return
  const r = await gemini.sessionGet(id, editor.accessor?.getText() ?? '')
  if (!r || docId.value !== id) return
  const restored: Turn[] = r.messages.map((m) => ({
    id: ++seq,
    docId: id,
    scope: m.scope,
    question: m.q,
    answer: m.answer.replace(/```mizaj-suggestion[^\S\n]*\n[\s\S]*?```/, '').trim() || '(لا نص)',
    error: null,
    truncated: false,
    cutoff: false,
    countdown: null,
    req: null,
    suggestion: null,
    sel: null,
    applied: false,
    refreshed: false,
    streaming: false,
    streamId: null,
    elapsed: 0,
    stopped: false,
    usage: null
  }))
  // turns asked in this session (not yet in the store's copy) stay; the saved history replaces the rest
  if (!allTurns.value.some((t) => t.docId === id)) allTurns.value = [...allTurns.value, ...restored]
  saved.value = r.messages.length > 0
  staleOnLoad.value = r.stale && r.messages.length > 0
}

async function newChat(): Promise<void> {
  const id = docId.value
  if (!id || busy.value) return
  await gemini.sessionReset(id)
  allTurns.value = allTurns.value.filter((t) => t.docId !== id)
  saved.value = false
  staleOnLoad.value = false
}

onMounted(() => void loadSession())
watch([docId, () => gemini.ready], () => void loadSession())

function resume(t: Turn): void {
  if (t.req && !busy.value) void run(t.id, t.req, true)
}

function apply(t: Turn): void {
  const acc = editor.accessor
  if (!acc || !t.sel || !t.suggestion) return
  const edits = diffMarkEdits(t.sel.text, t.suggestion, t.sel.from)
  if (!edits) return // base letters differ: never applied
  const before = acc.getText()
  const ok = acc.applyEdits(
    edits.map((e) => ({
      from: e.from,
      to: e.to,
      expected: t.sel!.text.slice(e.from - t.sel!.from, e.to - t.sel!.from),
      insert: e.insert
    }))
  )
  if (ok) {
    t.applied = true
    recordEvent(EVENT_LABELS.beforeGemini, before)
    recordEvent(EVENT_LABELS.gemini)
  } else notify('تغيّر النص منذ السؤال، لذا لم يُطبَّق الاقتراح.', { kind: 'info' })
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col text-sm" data-testid="gemini-panel">
    <div v-if="!gemini.ready" class="space-y-2 p-3" data-testid="gemini-panel-off">
      <p>مساعد Gemini غير مفعّل. هو اختياري ومعطّل افتراضياً.</p>
      <button
        class="rounded border px-3 py-1 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
        data-testid="gemini-open-settings"
        @click="quality.openSettings('online')"
      >
        فتح إعدادات Gemini
      </button>
    </div>
    <template v-else>
      <div
        v-if="docId"
        class="flex items-center justify-between gap-2 border-b px-3 py-1 text-xs dark:border-slate-700"
      >
        <span
          v-if="saved"
          class="rounded bg-mizaj-emerald/15 px-2 py-0.5 text-mizaj-emerald"
          data-testid="gemini-context-saved"
        >
          محفوظ في سياق المحادثة
        </span>
        <span v-else class="text-slate-500">لم يُحفظ المستند في سياق المحادثة بعد</span>
        <button
          type="button"
          class="rounded border px-2 py-0.5 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700"
          :disabled="busy"
          data-testid="gemini-new-chat"
          @click="newChat"
        >
          محادثة جديدة
        </button>
      </div>
      <p
        v-if="staleOnLoad"
        class="bg-mizaj-amber/20 px-3 py-1 text-xs text-mizaj-amber"
        data-testid="gemini-context-stale"
      >
        تغيّر نص المستند منذ آخر سؤال؛ سيُحدَّث سياق المحادثة عند سؤالك التالي.
      </p>
      <div ref="list" class="min-h-0 flex-1 space-y-3 overflow-auto p-3" aria-live="polite">
        <p v-if="!turns.length" class="text-slate-500" data-testid="gemini-hint">
          اسأل عن المستند الحالي (مثل «ما الكلمات المشكوك في تشكيلها؟»). لا يُرسَل شيء إلا عند الضغط
          على «إرسال»، والمساعد يقترح فقط ولا يعدّل مستندك.
        </p>
        <div v-for="t in turns" :key="t.id" class="space-y-1" data-testid="gemini-turn">
          <p class="rounded bg-slate-200 p-2 dark:bg-slate-700">
            <span class="text-xs text-slate-500">
              {{ t.scope === 'selection' ? 'عن التحديد' : 'عن المستند' }}
            </span>
            <br />
            {{ t.question }}
          </p>
          <p
            v-if="t.countdown !== null"
            class="rounded bg-mizaj-amber/20 p-2 text-mizaj-amber"
            data-testid="gemini-countdown"
          >
            تجاوزتَ حدّ الاستخدام؛ ستُعاد المحاولة تلقائياً بعد {{ t.countdown }} ثانية…
          </p>
          <div
            v-else-if="t.streaming"
            class="flex items-center gap-2"
            data-testid="gemini-streaming"
          >
            <span
              v-if="t.answer === null"
              class="text-slate-500"
              role="status"
              data-testid="gemini-thinking"
            >
              يفكّر… {{ t.elapsed }} ث
            </span>
            <span v-else class="text-xs text-slate-500">يكتب… {{ t.elapsed }} ث</span>
            <button
              type="button"
              class="rounded border px-3 py-1 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
              data-testid="gemini-stop"
              @click="stop(t)"
            >
              إيقاف
            </button>
          </div>
          <p
            v-if="t.refreshed"
            class="text-xs text-mizaj-amber"
            data-testid="gemini-context-refreshed"
          >
            تغيّر نص المستند، فجرى تحديث سياق المحادثة قبل هذه الإجابة.
          </p>
          <p
            v-if="t.stopped && !t.streaming && t.answer === null"
            class="text-xs text-slate-500"
            data-testid="gemini-stopped"
          >
            أُوقف الطلب قبل وصول أي نص.
          </p>
          <p
            v-if="t.error"
            class="rounded bg-mizaj-amber/20 p-2 text-mizaj-amber"
            data-testid="gemini-error"
          >
            {{ t.error }}
          </p>
          <template v-if="t.answer !== null">
            <p v-if="t.truncated" class="text-xs text-mizaj-amber" data-testid="gemini-truncated">
              اقتُطع جزء من المستند لطوله قبل إرساله؛ قد لا تشمل الإجابة كل النص.
            </p>
            <!-- eslint-disable-next-line vue/no-v-html -- escaped by renderMarkdown (no raw HTML passes) -->
            <div
              class="gemini-md rounded border p-2 dark:border-slate-600"
              dir="rtl"
              data-testid="gemini-answer"
              v-html="renderMarkdown(shown(t))"
            ></div>
            <p
              v-if="t.stopped && !t.streaming"
              class="text-xs text-slate-500"
              data-testid="gemini-stopped"
            >
              أُوقف الطلب؛ هذا ما وصل قبل الإيقاف.
            </p>
            <p
              v-if="t.usage && t.usage.totalTokens"
              class="text-xs text-slate-500"
              dir="rtl"
              data-testid="gemini-usage"
            >
              الرموز: الإدخال {{ t.usage.promptTokens }} · الإخراج {{ t.usage.outputTokens
              }}<template v-if="t.usage.thoughtsTokens">
                · التفكير {{ t.usage.thoughtsTokens }}</template
              ><template v-if="t.usage.cachedTokens">
                · من الذاكرة المخبّأة {{ t.usage.cachedTokens }}</template
              >
            </p>
            <div v-if="t.cutoff" class="flex items-center gap-2" data-testid="gemini-cutoff">
              <span class="text-xs text-mizaj-amber">انقطعت الإجابة لطولها.</span>
              <button
                type="button"
                class="rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700"
                :disabled="busy"
                data-testid="gemini-continue"
                @click="resume(t)"
              >
                متابعة
              </button>
            </div>
            <div
              v-if="t.suggestion"
              class="rounded border border-dashed p-2 dark:border-slate-500"
              data-testid="gemini-suggestion"
            >
              <div class="text-xs text-slate-500">اقتراح تشكيل (لا يُطبَّق تلقائياً)</div>
              <div class="font-[var(--editor-font)]" dir="rtl">{{ t.suggestion }}</div>
              <button
                v-if="canApply(t)"
                class="mt-1 rounded border px-3 py-1 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
                data-testid="gemini-apply"
                @click="apply(t)"
              >
                تطبيق
              </button>
              <span v-else-if="t.applied" class="text-xs text-mizaj-emerald">طُبّق</span>
              <span v-else class="text-xs text-slate-500" data-testid="gemini-text-only">
                الاقتراح للاطلاع فقط (لا يمكن تطبيقه لأن الحروف الأصلية ستتغير أو لأنه ليس على
                تحديد).
              </span>
            </div>
          </template>
        </div>
      </div>
      <form class="space-y-2 border-t p-2 dark:border-slate-700" @submit.prevent="send">
        <div class="flex gap-3 text-xs">
          <label class="flex items-center gap-1">
            <input v-model="scope" type="radio" value="doc" data-testid="gemini-scope-doc" />
            المستند كله
          </label>
          <label class="flex items-center gap-1">
            <input v-model="scope" type="radio" value="selection" data-testid="gemini-scope-sel" />
            التحديد الحالي
          </label>
        </div>
        <textarea
          v-model="question"
          rows="2"
          class="w-full rounded border p-2 dark:border-slate-600 dark:bg-slate-800"
          placeholder="اكتب سؤالك…"
          aria-label="سؤالك"
          data-testid="gemini-question"
          @keydown.ctrl.enter.prevent="send"
        ></textarea>
        <button
          type="submit"
          class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
          :disabled="!canAsk"
          data-testid="gemini-send"
        >
          إرسال
        </button>
      </form>
    </template>
  </div>
</template>
