<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'
import type { NormEdit } from '@renderer/editor/normalizeEdits'
import { useEditorStore } from '@renderer/stores/editor'
import { useQualityStore } from '@renderer/stores/quality'

const editor = useEditorStore()
const quality = useQualityStore()
const el = ref<HTMLElement | null>(null)
const close = (): void => {
  quality.normalizeOpen = false
}
useFocusTrap(el, close)

const opts = reactive({
  tatweel: true,
  presentation_forms: true,
  persian_letters: true,
  zero_width: true,
  nbsp: true,
  digits: 'keep',
  quotes: 'keep'
})
const labels: [keyof typeof opts, string][] = [
  ['tatweel', 'إزالة التطويل الزائد'],
  ['presentation_forms', 'تحويل أشكال العرض (PDF/ويب)'],
  ['persian_letters', 'توحيد الحروف الفارسية'],
  ['zero_width', 'إزالة المسافات الصفرية'],
  ['nbsp', 'تحويل المسافة غير القابلة للكسر']
]
const base = ref(0)
const edits = ref<NormEdit[]>([])
const selected = ref<Set<number>>(new Set())
const previewed = ref(false)
const field = 'rounded border px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800'

async function preview(): Promise<void> {
  const sel = editor.accessor?.selectionInfo()
  if (!sel) return
  base.value = sel.from
  try {
    const r = await useApi().post<{ edits: NormEdit[] }>('/api/spelling/normalize', {
      text: sel.text,
      options: { ...opts }
    })
    edits.value = r.edits
    selected.value = new Set(r.edits.map((_, i) => i))
    previewed.value = true
  } catch {
    /* toast shown */
  }
}
function toggle(i: number): void {
  const s = new Set(selected.value)
  if (s.has(i)) s.delete(i)
  else s.add(i)
  selected.value = s
}
const show = (s: string): string =>
  s === ''
    ? '(حذف)'
    : [...s]
        .map((c) => (/[​-‏ ⁠﻿]/.test(c) ? `U+${c.codePointAt(0)?.toString(16).toUpperCase()}` : c))
        .join('')
const count = computed(() => selected.value.size)

function apply(): void {
  const r = editor.accessor?.applyNormalize(base.value, edits.value, selected.value)
  if (!r) return
  if (r.skipped) notify(`تم تجاوز ${r.skipped} تعديل لأن النص تغيّر.`, { kind: 'info' })
  if (r.applied) {
    notify(`تم تطبيق ${r.applied} تعديل.`, { kind: 'success' })
    editor.announce(`تم توحيد النص: ${r.applied} تعديل`)
  }
  close()
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="close">
    <div
      ref="el"
      class="max-h-[90vh] w-[40rem] max-w-[95vw] overflow-y-auto rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800"
      role="dialog"
      aria-modal="true"
      aria-labelledby="norm-title"
      data-testid="normalize-dialog"
    >
      <div class="mb-2 flex items-center justify-between">
        <h2 id="norm-title" class="text-lg font-bold">توحيد النص (تنسيق طباعي)</h2>
        <button aria-label="إغلاق" data-testid="normalize-close" @click="close">✕</button>
      </div>
      <p class="text-xs text-slate-500">
        لا يتغير شيء قبل أن تعاين التعديلات وتختار ما تريد تطبيقه (يشمل المحدد أو كامل المستند).
      </p>
      <div class="mt-2 grid grid-cols-2 gap-1 text-sm">
        <label v-for="[k, label] in labels" :key="k" class="flex items-center gap-1">
          <input v-model="opts[k] as boolean" type="checkbox" :data-testid="`normalize-opt-${k}`" />
          {{ label }}
        </label>
        <label class="flex items-center gap-1">
          الأرقام
          <select
            v-model="opts.digits"
            :class="field"
            aria-label="نظام الأرقام"
            data-testid="normalize-digits"
          >
            <option value="keep">كما هي</option>
            <option value="arabic_indic">هندية (٠١٢)</option>
            <option value="western">غربية (012)</option>
          </select>
        </label>
        <label class="flex items-center gap-1">
          علامات الاقتباس
          <select
            v-model="opts.quotes"
            :class="field"
            aria-label="علامات الاقتباس"
            data-testid="normalize-quotes"
          >
            <option value="keep">كما هي</option>
            <option value="guillemets">« »</option>
          </select>
        </label>
      </div>
      <button
        class="mt-3 rounded bg-mizaj-emerald px-3 py-1 text-white"
        data-testid="normalize-preview"
        @click="preview"
      >
        معاينة
      </button>
      <div v-if="previewed" class="mt-3">
        <p data-testid="normalize-count">
          {{ edits.length ? `${count} من ${edits.length} تعديل محدد` : 'لا توجد تعديلات مقترحة.' }}
        </p>
        <ul class="max-h-64 divide-y overflow-auto dark:divide-slate-700">
          <li
            v-for="(e, i) in edits"
            :key="i"
            class="flex items-center gap-2 py-1 text-sm"
            data-testid="normalize-edit"
          >
            <input
              type="checkbox"
              :checked="selected.has(i)"
              :aria-label="e.message_ar"
              @change="toggle(i)"
            />
            <span class="font-editor"
              ><del>{{ show(e.old) }}</del> ← <ins>{{ show(e.new) }}</ins></span
            >
            <span class="text-xs text-slate-500">{{ e.message_ar }}</span>
          </li>
        </ul>
        <button
          class="mt-2 rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
          :disabled="!count"
          data-testid="normalize-apply"
          @click="apply"
        >
          تطبيق المحدد
        </button>
      </div>
    </div>
  </div>
</template>
