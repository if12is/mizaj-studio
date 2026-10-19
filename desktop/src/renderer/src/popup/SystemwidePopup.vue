<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * «مِزَاج في أي برنامج»: the small floating popup (RTL) shown near the cursor.
 * 4 operation buttons (keys 1-4), a preview with the changes highlighted, «استبدال» (Enter) and
 * «إلغاء» (Esc). It never talks to the backend: the main process captures the text, runs the
 * operation and puts the result back; this page only displays the state it is sent.
 */
const OPS: { id: SystemwideOpId; label: string; key: string; code: string }[] = [
  { id: 'proofread', label: 'تدقيق إملائي', key: '1', code: 'Digit1' },
  { id: 'punctuation', label: 'ترقيم', key: '2', code: 'Digit2' },
  { id: 'tashkeel', label: 'تشكيل', key: '3', code: 'Digit3' },
  { id: 'all', label: 'الكل', key: '4', code: 'Digit4' }
]
const SOURCE_LABEL = {
  word: 'Word: يُحفظ تنسيق كل حرف، وتُلغى النتيجة بـ Ctrl+Z',
  html: 'نسخة غنية (HTML): تبقى الوسوم والأنماط كما هي',
  plain: 'نص عادي: هذا البرنامج لا يوفّر تنسيقاً غنياً'
} as const

const st = ref<SystemwidePopupState | null>(null)
const root = ref<HTMLElement | null>(null)
let off: (() => void) | undefined

const api = (): SystemwideBridge | undefined => window.mizajAPI?.systemwide
const busy = computed(() => st.value?.phase === 'running' || st.value?.phase === 'applying')
const canReplace = computed(() => st.value?.phase === 'preview' && st.value.changed)

function run(op: SystemwideOpId): void {
  if (busy.value || st.value?.phase === 'error') return
  void api()?.popupRun(op)
}
function apply(): void {
  if (canReplace.value) void api()?.popupApply()
}
function cancel(): void {
  void api()?.popupCancel()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    apply()
    return
  }
  // physical digit keys, so the Arabic-Indic digits of an Arabic layout work as well
  const op = OPS.find((o) => e.code === o.code || e.code === o.code.replace('Digit', 'Numpad'))
  if (op && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault()
    run(op.id)
  }
}

async function fit(): Promise<void> {
  await nextTick()
  const h = root.value?.scrollHeight
  if (h) void api()?.popupResize(h + 2)
}

onMounted(async () => {
  document.documentElement.classList.add('dark')
  document.documentElement.dir = 'rtl'
  window.addEventListener('keydown', onKey)
  off = api()?.onPopupState((s) => (st.value = s))
  st.value = (await api()?.popupReady()) ?? null
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  off?.()
})
watch(st, () => void fit(), { deep: true })
</script>

<template>
  <div
    ref="root"
    class="flex min-h-screen flex-col gap-2 bg-slate-900 p-3 text-sm text-slate-100"
    dir="rtl"
    data-testid="sw-popup"
  >
    <header class="flex items-center justify-between">
      <h1 class="text-base font-bold">مِزَاج في أي برنامج</h1>
      <button
        class="rounded px-2 text-slate-400 hover:bg-slate-700"
        aria-label="إغلاق"
        data-testid="sw-popup-close"
        @click="cancel"
      >
        &#10005;
      </button>
    </header>

    <template v-if="st">
      <p
        class="line-clamp-2 rounded bg-slate-800 p-2 text-xs text-slate-300"
        data-testid="sw-snippet"
      >
        {{ st.snippet }}
      </p>
      <p class="text-xs text-slate-400" data-testid="sw-source">{{ SOURCE_LABEL[st.source] }}</p>

      <div class="grid grid-cols-4 gap-1.5" role="group" aria-label="الإجراءات">
        <button
          v-for="o in OPS"
          :key="o.id"
          class="rounded border px-1 py-1.5 text-xs font-semibold hover:bg-slate-700 disabled:opacity-50"
          :class="st.op === o.id ? 'border-emerald-400 bg-emerald-500/20' : 'border-slate-600'"
          :disabled="busy || st.phase === 'error'"
          :aria-pressed="st.op === o.id"
          :data-testid="`sw-op-${o.id}`"
          @click="run(o.id)"
        >
          <span class="ms-1 text-slate-400" dir="ltr">{{ o.key }}</span> {{ o.label }}
        </button>
      </div>

      <p v-if="st.phase === 'choose'" class="text-xs text-slate-400" data-testid="sw-hint">
        اختر إجراءً (اضغط 1 إلى 4).
        {{
          st.mode === 'direct'
            ? 'وضع «استبدال مباشر»: يُستبدل النص فور الاختيار.'
            : 'ستظهر معاينة قبل الاستبدال.'
        }}
      </p>
      <p v-else-if="st.phase === 'running'" class="text-xs text-slate-300" data-testid="sw-running">
        جارٍ المعالجة…
      </p>
      <p v-else-if="st.phase === 'applying'" class="text-xs text-slate-300">جارٍ الاستبدال…</p>

      <section
        v-if="st.phase === 'preview'"
        class="max-h-48 overflow-auto rounded border border-slate-700 bg-slate-800 p-2 leading-7"
        data-testid="sw-preview"
        aria-label="معاينة النتيجة"
      >
        <p v-if="!st.changed" class="text-slate-300" data-testid="sw-nochange">
          لا توجد تغييرات: النص سليم كما هو.
        </p>
        <template v-else>
          <template v-for="(seg, i) in st.segments" :key="i">
            <span v-if="seg.kind === 'same'" class="whitespace-pre-wrap">{{ seg.text }}</span>
            <template v-else>
              <del
                v-if="seg.letters"
                class="text-red-300 opacity-80"
                data-testid="sw-old"
                :title="'الأصل: ' + seg.old"
                >{{ seg.old }}</del
              >
              <mark
                class="whitespace-pre-wrap rounded bg-emerald-500/30 px-0.5 text-emerald-100"
                data-testid="sw-change"
                >{{ seg.text }}</mark
              >
            </template>
          </template>
        </template>
      </section>

      <p
        v-for="(w, i) in st.warnings"
        :key="i"
        class="rounded border border-amber-500 p-1.5 text-xs text-amber-300"
        role="status"
        data-testid="sw-warning"
      >
        {{ w }}
      </p>
      <p
        v-if="st.error"
        class="rounded border border-red-500 p-1.5 text-xs text-red-300"
        role="alert"
        data-testid="sw-error"
      >
        {{ st.error }}
      </p>

      <footer class="mt-auto flex items-center justify-between gap-2 pt-1">
        <span class="text-xs text-slate-500">Enter استبدال · Esc إلغاء</span>
        <div class="flex gap-2">
          <button
            class="rounded bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
            :disabled="!canReplace"
            data-testid="sw-replace"
            @click="apply"
          >
            استبدال
          </button>
          <button
            class="rounded border border-slate-600 px-3 py-1 hover:bg-slate-700"
            data-testid="sw-cancel"
            @click="cancel"
          >
            إلغاء
          </button>
        </div>
      </footer>
    </template>
  </div>
</template>
