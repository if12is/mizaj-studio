<script setup lang="ts">
import { computed } from 'vue'
import {
  CATEGORY_LABEL,
  CONFIDENCE_LABEL,
  REDACT_CATEGORIES,
  buildMapping,
  mappingToCsv
} from '@renderer/legal/tools'
import { useRedactStore } from '@renderer/stores/legalTools'
import { useEditorStore } from '@renderer/stores/editor'

const props = defineProps<{ openDocument: (id: number) => Promise<void> }>()
const rd = useRedactStore()
const editor = useEditorStore()
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
const btn =
  'rounded border px-2 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700'
const mapping = computed(() => buildMapping(rd.chosen()))
const conf: Record<string, string> = {
  high: 'bg-emerald-600',
  medium: 'bg-amber-600',
  low: 'bg-red-600'
}

function toggleCat(c: string, on: boolean): void {
  rd.categories = on ? [...new Set([...rd.categories, c])] : rd.categories.filter((x) => x !== c)
}
function exportMapping(): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(
    new Blob(['﻿' + mappingToCsv(mapping.value)], { type: 'text/csv;charset=utf-8' })
  )
  a.download = 'mizaj-redaction-mapping.csv'
  a.click()
  URL.revokeObjectURL(a.href)
}
</script>

<template>
  <div class="space-y-3 p-3 text-sm" data-testid="redact-tool">
    <p
      class="rounded bg-mizaj-amber/20 px-2 py-1 text-xs text-mizaj-amber"
      data-testid="redact-warning"
    >
      الكشف آلي ولا يضمن العثور على كل البيانات الشخصية؛ راجع كل اقتراح ولا تعتمد عليه وحده. جدول
      المطابقة يبقى محلياً ويجب عدم مشاركته.
    </p>
    <fieldset>
      <legend class="font-semibold">الفئات</legend>
      <div class="flex flex-wrap gap-x-3 gap-y-1">
        <label v-for="[k, l] in REDACT_CATEGORIES" :key="k" class="flex items-center gap-1">
          <input
            type="checkbox"
            :checked="rd.categories.includes(k)"
            :data-testid="`redact-cat-${k}`"
            @change="toggleCat(k, ($event.target as HTMLInputElement).checked)"
          />
          {{ l }}
        </label>
      </div>
    </fieldset>
    <label class="block">
      <span class="font-semibold">نمط الاستبدال</span>
      <select v-model="rd.style" :class="field" class="mt-1 w-full" data-testid="redact-style">
        <option value="placeholder">وسم مثل [هاتف 1]</option>
        <option value="mask">تعتيم (●●●)</option>
        <option value="pseudonym">اسم مستعار</option>
      </select>
    </label>
    <label class="block">
      <span class="font-semibold">أسماء إضافية (اسم في كل سطر)</span>
      <textarea
        v-model="rd.names"
        :class="field"
        class="mt-1 w-full"
        rows="2"
        data-testid="redact-names"
      />
    </label>
    <label class="flex items-center gap-2">
      <input v-model="rd.useParties" type="checkbox" data-testid="redact-use-parties" />
      استخدام أسماء الأطراف المعرَّفة في المستند
    </label>
    <button
      class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
      :disabled="rd.running || !editor.accessor"
      data-testid="redact-run"
      @click="rd.run()"
    >
      اقتراح الإخفاء
    </button>

    <template v-if="rd.ran">
      <p v-if="!rd.edits.length" class="text-mizaj-emerald" data-testid="redact-none">
        لم يُعثر على بيانات للإخفاء.
      </p>
      <template v-else>
        <div class="flex flex-wrap items-center gap-2">
          <span data-testid="redact-count"
            >{{ rd.selected.length }} من {{ rd.edits.length }} محدد</span
          >
          <button
            :class="btn"
            data-testid="redact-select-all"
            @click="rd.selected = rd.edits.map((e) => e.id)"
          >
            تحديد الكل
          </button>
          <button :class="btn" data-testid="redact-select-none" @click="rd.selected = []">
            إلغاء التحديد
          </button>
        </div>
        <ul class="max-h-64 space-y-1 overflow-auto" data-testid="redact-list">
          <li
            v-for="e in rd.edits"
            :key="e.id"
            class="flex items-start gap-2 rounded border p-2 dark:border-slate-600"
            data-testid="redact-item"
            :data-category="e.category"
          >
            <input
              type="checkbox"
              :checked="rd.selected.includes(e.id)"
              :aria-label="`إخفاء ${e.expected}`"
              data-testid="redact-check"
              @change="rd.toggle(e.id, ($event.target as HTMLInputElement).checked)"
            />
            <button class="flex-1 text-start" data-testid="redact-jump" @click="rd.jump(e)">
              <span class="font-editor">{{ e.expected }}</span>
              ←
              <span class="font-editor">{{ e.replacement }}</span>
              <span class="block text-xs text-slate-500">
                {{ CATEGORY_LABEL[e.category] ?? e.category }}
                <span
                  class="rounded px-1 text-white"
                  :class="conf[e.confidence]"
                  data-testid="redact-confidence"
                >
                  {{ CONFIDENCE_LABEL[e.confidence] }}
                </span>
                <span v-if="e.note"> — {{ e.note }}</span>
              </span>
            </button>
          </li>
        </ul>
        <div class="flex flex-wrap gap-2">
          <button
            class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
            :disabled="!rd.selected.length"
            data-testid="redact-apply"
            @click="rd.applyToDocument()"
          >
            تطبيق المحدد على المستند
          </button>
          <button
            :class="btn"
            :disabled="!rd.selected.length"
            data-testid="redact-save-copy"
            @click="rd.saveRedactedCopy(props.openDocument)"
          >
            حفظ نسخة مُخفاة
          </button>
        </div>
        <p class="text-xs text-slate-500">
          «حفظ نسخة مُخفاة» ينشئ مستنداً جديداً ويترك الأصل كما هو. التطبيق على المستند خطوة تراجع
          واحدة.
        </p>

        <section v-if="mapping.length" data-testid="redact-mapping">
          <h3 class="font-semibold">جدول المطابقة (محلي)</h3>
          <table class="w-full text-xs">
            <thead>
              <tr class="text-start">
                <th class="text-start">البديل</th>
                <th class="text-start">الفئة</th>
                <th class="text-start">الأصل</th>
                <th class="text-start">المرات</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(m, n) in mapping" :key="n" data-testid="redact-map-row">
                <td class="font-editor">{{ m.replacement }}</td>
                <td>{{ CATEGORY_LABEL[m.category] ?? m.category }}</td>
                <td class="font-editor">{{ m.original }}</td>
                <td>{{ m.count }}</td>
              </tr>
            </tbody>
          </table>
          <button
            :class="btn"
            class="mt-1"
            data-testid="redact-export-mapping"
            @click="exportMapping"
          >
            تصدير الجدول (CSV محلي)
          </button>
        </section>
      </template>
    </template>
  </div>
</template>
