<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useEditorStore } from '@renderer/stores/editor'
import { useGeminiStore } from '@renderer/stores/gemini'
import { useQualityStore } from '@renderer/stores/quality'
import { diffMarkEdits } from '@renderer/editor/markEdits'
import { stripMarks } from '@renderer/editor/arabic'
import { notify } from '@renderer/api/toast'

interface Turn {
  id: number
  scope: 'doc' | 'selection'
  question: string
  answer: string | null
  error: string | null
  truncated: boolean
  suggestion: string | null
  /** selection the suggestion refers to (apply is offered only if its base letters are identical) */
  sel: { from: number; to: number; text: string } | null
  applied: boolean
}

const editor = useEditorStore()
const gemini = useGeminiStore()
const quality = useQualityStore()
const question = ref('')
const scope = ref<'doc' | 'selection'>('doc')
const turns = ref<Turn[]>([])
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
    scope: scope.value,
    question: q,
    answer: null,
    error: null,
    truncated: false,
    suggestion: null,
    sel: null,
    applied: false
  }
  let req: Parameters<typeof gemini.ask>[0]
  if (scope.value === 'selection') {
    const s = acc.selectionInfo()
    const hasSel = s.to > s.from
    if (!hasSel) {
      turns.value.push({ ...turn, error: 'حدّد نصاً في المحرر أولاً، أو اختر «المستند كله».' })
      return
    }
    turn.sel = s
    req = { kind: 'selection', question: q, text: s.text }
  } else req = { kind: 'document', question: q, text: acc.getText() }
  turns.value.push(turn)
  question.value = ''
  busy.value = true
  try {
    const r = await gemini.ask(req)
    const t = turns.value.find((x) => x.id === turn.id)!
    if (r.ok) {
      t.answer = r.text || '(لا نص)'
      t.truncated = r.truncated
      t.suggestion = r.suggestion
    } else t.error = r.message
  } finally {
    busy.value = false
    await nextTick()
    list.value?.scrollTo({ top: list.value.scrollHeight })
  }
}

function apply(t: Turn): void {
  const acc = editor.accessor
  if (!acc || !t.sel || !t.suggestion) return
  const edits = diffMarkEdits(t.sel.text, t.suggestion, t.sel.from)
  if (!edits) return // base letters differ: never applied
  const ok = acc.applyEdits(
    edits.map((e) => ({
      from: e.from,
      to: e.to,
      expected: t.sel!.text.slice(e.from - t.sel!.from, e.to - t.sel!.from),
      insert: e.insert
    }))
  )
  if (ok) t.applied = true
  else notify('تغيّر النص منذ السؤال، لذا لم يُطبَّق الاقتراح.', { kind: 'info' })
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
          <p v-if="t.answer === null && !t.error" class="text-slate-500">جاري الاستشارة...</p>
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
            <p
              class="whitespace-pre-wrap rounded border p-2 dark:border-slate-600"
              data-testid="gemini-answer"
            >
              {{ t.answer }}
            </p>
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
