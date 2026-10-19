<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { notify } from '@renderer/api/toast'
import {
  allCopyText,
  confidenceLevel,
  fieldCopyText,
  jumpTargets,
  LEVEL_LABEL,
  type CardField
} from '@renderer/legal/caseCard'
import { useCaseCardStore } from '@renderer/stores/caseCard'
import { useEditorStore } from '@renderer/stores/editor'
import { useProjectsStore } from '@renderer/stores/projects'

const card = useCaseCardStore()
const editor = useEditorStore()
const projects = useProjectsStore()
const cursor = reactive<Record<string, number>>({})

const visible = computed(() => !card.hidden && card.fields.length > 0)

// switching documents: reload at once (the hidden flag is per document)
watch(
  () => projects.currentDocument?.id,
  () => void card.refresh(),
  { immediate: true }
)

function jump(f: CardField, i?: number): void {
  const targets = jumpTargets(f)
  const idx = i ?? ((cursor[f.key] ?? -1) + 1) % targets.length
  cursor[f.key] = idx
  const t = targets[idx]
  editor.accessor?.jumpTo(t.start, t.end)
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    notify(`تم نسخ ${what}.`, { kind: 'success', ms: 1500 })
  } catch {
    notify('تعذّر النسخ إلى الحافظة.', { kind: 'info' })
  }
}
</script>

<template>
  <section
    v-if="visible"
    class="border-b border-slate-200 bg-slate-50 px-3 py-1 text-xs dark:border-slate-700 dark:bg-slate-800/60"
    aria-label="بطاقة القضية"
    data-testid="case-card"
    :data-collapsed="card.collapsed"
  >
    <div class="flex items-center gap-2">
      <button
        class="font-semibold"
        :aria-expanded="!card.collapsed"
        data-testid="case-card-collapse"
        @click="card.collapsed = !card.collapsed"
      >
        {{ card.collapsed ? '▸' : '▾' }} بطاقة القضية
      </button>
      <span v-if="card.collapsed" class="truncate text-slate-500" data-testid="case-card-summary">
        {{ card.fields[0].value }}
      </span>
      <span class="flex-1" />
      <button
        class="rounded border px-2 py-0.5 dark:border-slate-600"
        data-testid="case-card-copy-all"
        @click="copy(allCopyText(card.fields), 'بطاقة القضية')"
      >
        نسخ الكل
      </button>
      <button
        class="rounded border px-2 py-0.5 dark:border-slate-600"
        data-testid="case-card-hide"
        @click="card.toggleHidden()"
      >
        إخفاء
      </button>
    </div>
    <ul v-if="!card.collapsed" class="mt-1 grid gap-1 sm:grid-cols-2">
      <li
        v-for="f in card.fields"
        :key="f.key"
        class="flex items-start gap-2 rounded border p-1 dark:border-slate-600"
        data-testid="case-card-field"
        :data-key="f.key"
        :data-confidence="confidenceLevel(f.confidence)"
      >
        <div class="min-w-0 flex-1">
          <span class="text-slate-500">{{ f.label_ar }}</span>
          <span
            class="ms-1 rounded px-1"
            :class="{
              'bg-mizaj-emerald/20': confidenceLevel(f.confidence) === 'high',
              'bg-mizaj-amber/20': confidenceLevel(f.confidence) === 'mid',
              'bg-red-500/20': confidenceLevel(f.confidence) === 'low'
            }"
            :title="LEVEL_LABEL[confidenceLevel(f.confidence)]"
          >
            {{ Math.round(f.confidence * 100) }}%
          </span>
          <template v-if="f.items?.length">
            <button
              v-for="(it, i) in f.items"
              :key="i"
              class="line-clamp-2 block w-full text-start font-editor hover:underline"
              data-testid="case-card-jump"
              @click="jump(f, i)"
            >
              {{ it.text }}
            </button>
          </template>
          <button
            v-else
            class="line-clamp-3 block w-full whitespace-pre-line text-start font-editor hover:underline"
            data-testid="case-card-jump"
            :title="
              (f.occurrences?.length ?? 0) > 1
                ? `يظهر ${f.occurrences?.length} مرات؛ اضغط للانتقال إلى التالي`
                : 'انتقال إلى موضعه'
            "
            @click="jump(f)"
          >
            {{ f.value }}
          </button>
        </div>
        <button
          class="shrink-0 rounded border px-1 dark:border-slate-600"
          data-testid="case-card-copy"
          @click="copy(fieldCopyText(f), f.label_ar)"
        >
          نسخ
        </button>
      </li>
    </ul>
  </section>
</template>
