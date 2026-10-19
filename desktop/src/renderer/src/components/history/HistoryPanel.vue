<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '@renderer/components/ui/ConfirmDialog.vue'
import { useHistoryStore } from '@renderer/stores/history'
import {
  arDigits,
  deltaLabels,
  entryTitle,
  previewSegments,
  timeLabel,
  type VersionMeta
} from '@renderer/history/logic'

const history = useHistoryStore()
const checkpointName = ref('')
const confirming = ref(false)
const closeBtn = ref<HTMLButtonElement | null>(null)

const segs = computed(() => (history.diff ? previewSegments(history.diff.ops) : []))

onMounted(() => closeBtn.value?.focus())

function kindMark(v: VersionMeta): string {
  if (v.kind === 'checkpoint') return '★'
  if (v.kind === 'restore') return '↺'
  return ''
}

async function saveCheckpoint(): Promise<void> {
  if (await history.saveCheckpoint(checkpointName.value.trim())) checkpointName.value = ''
}

async function doRestore(): Promise<void> {
  confirming.value = false
  if (history.selectedId !== null) await history.restore(history.selectedId)
}
</script>

<template>
  <aside
    class="fixed bottom-8 end-2 top-10 z-40 flex w-[27rem] max-w-[96vw] flex-col rounded-lg border border-slate-300 bg-white text-sm text-slate-900 shadow-xl dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
    role="complementary"
    aria-label="سجل التعديلات"
    data-testid="history-panel"
    dir="rtl"
    @keydown.esc="!confirming && history.toggle(false)"
  >
    <header class="flex items-center gap-2 border-b px-3 py-2 dark:border-slate-700">
      <h2 class="flex-1 font-bold">سجل التعديلات</h2>
      <span class="text-xs text-slate-500" data-testid="history-count">
        {{ arDigits(history.total) }} نسخة
      </span>
      <button
        ref="closeBtn"
        class="rounded px-2 hover:bg-slate-200 dark:hover:bg-slate-700"
        aria-label="إغلاق"
        data-testid="history-close"
        @click="history.toggle(false)"
      >
        ✕
      </button>
    </header>

    <form
      class="flex items-center gap-2 border-b px-3 py-2 dark:border-slate-700"
      @submit.prevent="saveCheckpoint"
    >
      <input
        v-model="checkpointName"
        class="min-w-0 flex-1 rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
        placeholder="اسم اختياري لنقطة الاسترجاع"
        maxlength="120"
        aria-label="اسم نقطة الاسترجاع"
        data-testid="history-checkpoint-name"
      />
      <button
        type="submit"
        class="shrink-0 rounded bg-mizaj-emerald px-3 py-1 font-semibold text-white disabled:opacity-50"
        :disabled="history.docId === null"
        data-testid="history-checkpoint-save"
      >
        حفظ نقطة استرجاع
      </button>
    </form>

    <div class="min-h-0 flex-1 overflow-y-auto" data-testid="history-list">
      <p v-if="history.loading && !history.items.length" class="p-3 text-slate-500">
        جارٍ التحميل…
      </p>
      <p v-else-if="!history.items.length" class="p-3 text-slate-500" data-testid="history-empty">
        لا توجد نسخ محفوظة بعد. تُسجَّل النسخ تلقائياً مع كل حفظ.
      </p>
      <section v-for="g in history.groups" :key="g.key" :aria-label="g.label">
        <h3
          class="sticky top-0 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-900 dark:text-slate-300"
          data-testid="history-day"
        >
          {{ g.label }}
        </h3>
        <ul>
          <li v-for="v in g.items" :key="v.id">
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-start hover:bg-slate-100 dark:hover:bg-slate-700"
              :class="v.id === history.selectedId ? 'bg-mizaj-emerald/15' : ''"
              :aria-current="v.id === history.selectedId"
              data-testid="history-entry"
              :data-id="v.id"
              :data-kind="v.kind"
              @click="history.select(v.id)"
            >
              <span class="w-12 shrink-0 text-xs tabular-nums text-slate-500">{{
                timeLabel(v.created_at)
              }}</span>
              <span class="min-w-0 flex-1 truncate" data-testid="history-entry-label">
                <span v-if="kindMark(v)" class="text-mizaj-amber">{{ kindMark(v) }}</span>
                {{ entryTitle(v) }}
              </span>
              <span class="shrink-0 text-xs tabular-nums text-emerald-600 dark:text-emerald-400">{{
                deltaLabels(v).plus
              }}</span>
              <span class="shrink-0 text-xs tabular-nums text-red-600 dark:text-red-400">{{
                deltaLabels(v).minus
              }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>

    <div
      v-if="history.selected"
      class="flex max-h-[45%] min-h-[9rem] flex-col border-t dark:border-slate-700"
      data-testid="history-preview"
    >
      <div class="flex items-center gap-2 px-3 py-1.5">
        <span class="min-w-0 flex-1 truncate font-semibold">{{
          entryTitle(history.selected)
        }}</span>
        <button
          class="shrink-0 rounded bg-mizaj-amber px-3 py-1 font-semibold text-black disabled:opacity-50"
          :disabled="history.busy"
          data-testid="history-restore"
          @click="confirming = true"
        >
          استعادة هذه النسخة
        </button>
      </div>
      <p class="px-3 pb-1 text-xs text-slate-500">
        <span class="bg-emerald-500/25 px-1">يعود بالاستعادة</span>
        <span class="mx-1 bg-red-500/25 px-1 line-through">يُزال بالاستعادة</span>
        مقارنةً بالنص الحالي
      </p>
      <div
        class="mizaj-editor min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap px-3 pb-2 leading-loose"
        data-testid="history-diff"
        dir="rtl"
        lang="ar"
      >
        <p v-if="history.diffLoading" class="text-slate-500">جارٍ المقارنة…</p>
        <p v-else-if="history.identical" class="text-slate-500" data-testid="history-identical">
          هذه النسخة مطابقة للنص الحالي.
        </p>
        <template v-else>
          <span
            v-for="(s, i) in segs"
            :key="i"
            :class="
              s.kind === 'gain'
                ? 'bg-emerald-500/25'
                : s.kind === 'lose'
                  ? 'bg-red-500/25 line-through'
                  : ''
            "
            :data-seg="s.kind"
            >{{ s.text }}</span
          >
        </template>
      </div>
    </div>

    <ConfirmDialog
      v-if="confirming"
      title="استعادة هذه النسخة؟"
      message="سيُستبدل نص المستند الحالي بهذه النسخة. تُحفظ الحالة الحالية في السجل، فيمكنك التراجع عن الاستعادة."
      confirm-label="استعادة"
      @confirm="doRestore"
      @cancel="confirming = false"
    />
  </aside>
</template>
