<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useEditorStore } from '@renderer/stores/editor'
import { recordEvent } from '@renderer/stores/history'
import { EVENT_LABELS, replaceAllLabel } from '@renderer/history/logic'

const editor = useEditorStore()
const query = ref('')
const replacement = ref('')
const ignoreMarks = ref(true)
const foldLetters = ref(false)
const wholeWord = ref(false)
const stripReplacementMarks = ref(false)
const input = ref<HTMLInputElement | null>(null)
const field = 'rounded border px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800'

function push(): void {
  editor.accessor?.find.set({
    query: query.value,
    replacement: replacement.value,
    ignoreMarks: ignoreMarks.value,
    foldLetters: foldLetters.value,
    wholeWord: wholeWord.value,
    stripReplacementMarks: stripReplacementMarks.value
  })
}
watch([query, replacement, ignoreMarks, foldLetters, wholeWord, stripReplacementMarks], push)
watch(
  () => editor.findOpen,
  async (open) => {
    if (open) {
      await nextTick()
      input.value?.focus()
      input.value?.select()
      push()
    } else {
      editor.accessor?.find.clear()
    }
  }
)
function close(): void {
  editor.findOpen = false
}
async function replaceAll(): Promise<void> {
  const before = editor.accessor?.getText()
  const n = editor.accessor?.find.replaceAll() ?? 0
  if (n > 0) {
    recordEvent(EVENT_LABELS.beforeReplaceAll, before)
    recordEvent(replaceAllLabel(n))
  }
  editor.announce(`تم استبدال ${n} موضع`)
}
</script>

<template>
  <div
    v-if="editor.findOpen"
    class="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1 dark:border-slate-700 dark:bg-slate-900/60"
    role="search"
    aria-label="بحث واستبدال"
    data-testid="find-bar"
    @keydown.esc="close"
  >
    <input
      ref="input"
      v-model="query"
      :class="field"
      placeholder="بحث"
      aria-label="نص البحث"
      data-testid="find-input"
      @keydown.enter.exact.prevent="editor.accessor?.find.step(1)"
      @keydown.shift.enter.prevent="editor.accessor?.find.step(-1)"
    />
    <input
      v-model="replacement"
      :class="field"
      placeholder="استبدال"
      aria-label="نص الاستبدال"
      data-testid="find-replace-input"
    />
    <span class="text-xs" aria-live="polite" data-testid="find-count">
      {{
        editor.findInfo.count
          ? `${editor.findInfo.current + 1} / ${editor.findInfo.count}`
          : query
            ? 'لا نتائج'
            : ''
      }}
    </span>
    <button
      class="rounded border px-2 text-sm dark:border-slate-600"
      aria-label="السابق"
      data-testid="find-prev"
      @click="editor.accessor?.find.step(-1)"
    >
      السابق
    </button>
    <button
      class="rounded border px-2 text-sm dark:border-slate-600"
      aria-label="التالي"
      data-testid="find-next"
      @click="editor.accessor?.find.step(1)"
    >
      التالي
    </button>
    <button
      class="rounded border px-2 text-sm dark:border-slate-600"
      data-testid="find-replace"
      @click="editor.accessor?.find.replace()"
    >
      استبدال
    </button>
    <button
      class="rounded bg-mizaj-emerald px-2 text-sm text-white"
      data-testid="find-replace-all"
      @click="replaceAll"
    >
      استبدال الكل
    </button>
    <label class="flex items-center gap-1 text-xs">
      <input v-model="ignoreMarks" type="checkbox" data-testid="find-ignore-marks" />
      تجاهل التشكيل
    </label>
    <label class="flex items-center gap-1 text-xs">
      <input v-model="foldLetters" type="checkbox" data-testid="find-fold" />
      تجاهل الهمزات والتاء المربوطة
    </label>
    <label class="flex items-center gap-1 text-xs">
      <input v-model="wholeWord" type="checkbox" data-testid="find-whole-word" />
      كلمة كاملة
    </label>
    <label class="flex items-center gap-1 text-xs">
      <input v-model="stripReplacementMarks" type="checkbox" data-testid="find-strip-replacement" />
      إزالة تشكيل الاستبدال
    </label>
    <button class="text-sm" aria-label="إغلاق البحث" data-testid="find-close" @click="close">
      ✕
    </button>
  </div>
</template>
