<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useEditorStore } from '@renderer/stores/editor'
import { notify } from '@renderer/api/toast'
import { compareTexts, type CompareResult, type Seg } from '@renderer/proofread/compare'
import { arDigits } from '@renderer/history/logic'

/**
 * «مقارنة» (قبل / بعد): the original on one side, the result on the other. Both sides sit in
 * ONE scroll container, one grid row per paragraph, so they scroll together and stay aligned.
 * Proofreading changes are amber, diacritics-only changes emerald; clicking a changed word
 * reverts just that word in the editor (one undoable edit).
 */
const editor = useEditorStore()
const before = computed(() => editor.diffBase ?? '')
const current = ref(editor.accessor?.getText() ?? '')
const result = shallowRef<CompareResult>(compareTexts(before.value, current.value))
const changesOnly = ref(false)

const rows = computed(() =>
  changesOnly.value ? result.value.rows.filter((r) => r.changed) : result.value.rows
)

function recompute(): void {
  current.value = editor.accessor?.getText() ?? ''
  result.value = compareTexts(before.value, current.value)
}

function revert(s: Seg): void {
  if (!s.revertable) return
  const ok = editor.accessor?.applyEdit(
    s.afterFrom,
    s.afterFrom + s.after.length,
    s.after,
    s.before
  )
  if (!ok) notify('تغيّر النص؛ أعيد حساب المقارنة.', { kind: 'info' })
  else editor.announce(`أُعيدت الكلمة إلى أصلها: ${s.before || 'حذف'}`)
  recompute()
}

const KIND_LABEL = { proof: 'تصحيح تدقيق', diac: 'تشكيل فقط' } as const
const cell =
  'diff-seg rounded-sm px-0.5 align-baseline text-inherit transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-mizaj-emerald'
const tone = (k: Seg['kind']): string =>
  k === 'proof'
    ? 'bg-amber-200 text-slate-900 hover:bg-amber-300 dark:bg-amber-500/35 dark:text-amber-50 dark:hover:bg-amber-500/55'
    : 'bg-emerald-200 text-slate-900 hover:bg-emerald-300 dark:bg-emerald-500/30 dark:text-emerald-50 dark:hover:bg-emerald-500/50'
</script>

<template>
  <div class="mizaj-diff mizaj-editor flex min-h-0 flex-1 flex-col" data-testid="diff-view">
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 px-3 py-1 text-xs dark:border-slate-700"
      data-testid="diff-legend"
    >
      <span class="inline-flex items-center gap-1">
        <i class="inline-block h-3 w-3 rounded-sm bg-amber-300 dark:bg-amber-500/60" />
        تغيير تدقيق (حروف) <b data-testid="diff-count-proof">{{ arDigits(result.proof) }}</b>
      </span>
      <span class="inline-flex items-center gap-1">
        <i class="inline-block h-3 w-3 rounded-sm bg-emerald-300 dark:bg-emerald-500/60" />
        تشكيل فقط <b data-testid="diff-count-diac">{{ arDigits(result.diac) }}</b>
      </span>
      <span class="text-slate-500 dark:text-slate-400">انقر كلمة ملوّنة لإعادتها إلى أصلها</span>
      <span class="flex-1" />
      <label class="inline-flex items-center gap-1">
        <input v-model="changesOnly" type="checkbox" data-testid="diff-changes-only" />
        المتغيّر فقط
      </label>
    </div>
    <div
      class="grid grid-cols-2 border-b border-slate-200 px-3 py-1 text-xs font-semibold dark:border-slate-700"
    >
      <span>الأصلي (قبل)</span>
      <span>النتيجة (بعد)</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto" data-testid="diff-scroll">
      <p
        v-if="!result.proof && !result.diac"
        class="p-4 text-center text-sm text-slate-500"
        data-testid="diff-empty"
      >
        لا فروق بين الأصل والنتيجة.
      </p>
      <div
        v-for="(row, i) in rows"
        :key="i"
        class="diff-row grid grid-cols-2 gap-4 border-b border-slate-100 px-3 py-1 dark:border-slate-800"
        :data-changed="row.changed || undefined"
        data-testid="diff-row"
      >
        <p
          class="font-editor min-w-0 whitespace-pre-wrap break-words"
          dir="rtl"
          lang="ar"
          data-testid="diff-before"
        >
          <template v-for="(s, k) in row.segs" :key="k">
            <span v-if="s.kind === 'same'">{{ s.before }}</span>
            <button
              v-else-if="s.before"
              type="button"
              :class="[cell, tone(s.kind)]"
              :data-kind="s.kind"
              :disabled="!s.revertable"
              :title="`${KIND_LABEL[s.kind]} — انقر لإعادة الكلمة`"
              data-testid="diff-change-before"
              @click="revert(s)"
            >
              {{ s.before }}
            </button>
          </template>
        </p>
        <p
          class="font-editor min-w-0 whitespace-pre-wrap break-words"
          dir="rtl"
          lang="ar"
          data-testid="diff-after"
        >
          <template v-for="(s, k) in row.segs" :key="k">
            <span v-if="s.kind === 'same'">{{ s.after }}</span>
            <button
              v-else-if="s.after"
              type="button"
              :class="[cell, tone(s.kind)]"
              :data-kind="s.kind"
              :disabled="!s.revertable"
              :title="`${KIND_LABEL[s.kind]} — انقر لإعادة الكلمة إلى أصلها`"
              data-testid="diff-change"
              @click="revert(s)"
            >
              {{ s.after }}
            </button>
          </template>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 2rem;
}
.diff-seg:disabled {
  cursor: default;
}
</style>
