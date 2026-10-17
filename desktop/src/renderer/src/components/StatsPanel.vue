<script setup lang="ts">
import { computed, ref } from 'vue'
import { useApi } from '@renderer/api'
import { useEditorStore } from '@renderer/stores/editor'
import { useProjectsStore } from '@renderer/stores/projects'
import { osmanBand, useQualityStore, type ReadabilityResult } from '@renderer/stores/quality'

const editor = useEditorStore()
const projects = useProjectsStore()
const quality = useQualityStore()
const manual = computed(() => editor.manualEdits[projects.currentDocument?.id ?? 0]?.count ?? 0)
const busy = ref(false)
const maxWords = ref(30)

async function analyze(): Promise<void> {
  const text = editor.accessor?.getText() ?? ''
  if (!text.trim()) return
  busy.value = true
  try {
    quality.readability = await useApi().post<ReadabilityResult>('/api/spelling/readability', {
      text,
      max_sentence_words: maxWords.value
    })
  } catch {
    /* toast shown */
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="border-b border-slate-200 bg-slate-50 px-3 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/60"
    data-testid="stats-panel"
  >
    <div class="flex flex-wrap items-center gap-6">
      <span
        >الكلمات: <b data-testid="stat-words">{{ editor.wordCount }}</b></span
      >
      <span
        >كثافة الحركات: <b data-testid="stat-density">{{ editor.density.toFixed(1) }}%</b></span
      >
      <span>
        كلمات معدّلة يدوياً: <b data-testid="stat-manual">{{ manual }}</b>
        <span class="text-slate-500">(محفوظة مع المستند)</span>
      </span>
      <span v-if="editor.splitLines">
        فقرات طويلة مقسّمة: <b data-testid="stat-split">{{ editor.splitLines }}</b>
      </span>
      <label class="flex items-center gap-1">
        أقصى كلمات للجملة
        <input
          v-model.number="maxWords"
          type="number"
          min="5"
          max="500"
          aria-label="أقصى عدد كلمات للجملة"
          class="w-14 rounded border px-1 dark:border-slate-600 dark:bg-slate-800"
        />
      </label>
      <button
        class="rounded border px-2 py-0.5 dark:border-slate-600"
        :disabled="busy"
        data-testid="readability-run"
        @click="analyze"
      >
        تحليل المقروئية
      </button>
    </div>
    <div v-if="quality.readability" class="mt-1 space-y-1" data-testid="readability-panel">
      <p>
        مؤشر OSMAN:
        <b data-testid="readability-osman">{{
          quality.readability.metrics.osman?.toFixed(1) ?? '—'
        }}</b>
        ({{ osmanBand(quality.readability.metrics.osman) }}؛ الأعلى أسهل) — الجمل:
        <span data-testid="readability-sentences">{{ quality.readability.metrics.sentences }}</span>
        — متوسط كلمات الجملة: {{ quality.readability.metrics.avg_sentence_words }} — متوسط طول
        الكلمة: {{ quality.readability.metrics.avg_word_length }}
        <span v-if="quality.readability.passive">
          — المبني للمجهول: {{ quality.readability.passive.count }}</span
        >
      </p>
      <p class="text-slate-500">مؤشرات تقريبية للاسترشاد وليست حكماً على جودة النص.</p>
      <ul
        v-if="quality.readability.long_sentences.length"
        class="max-h-24 overflow-auto"
        data-testid="readability-long-list"
      >
        <li v-for="(s, i) in quality.readability.long_sentences" :key="i">
          <button
            class="text-start hover:underline"
            data-testid="readability-long"
            @click="editor.accessor?.jumpTo(s.start16, s.end16)"
          >
            جملة طويلة ({{ s.words }} كلمة) — انتقل إليها
          </button>
        </li>
      </ul>
      <p v-else data-testid="readability-no-long">لا توجد جمل أطول من الحد المحدد.</p>
    </div>
  </div>
</template>
