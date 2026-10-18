<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'
import { useProofreadStore } from '@renderer/stores/proofread'
import {
  YA_STYLE_OPTIONS,
  contextOf,
  showChars,
  type ProofCategory,
  type YaStyle
} from '@renderer/proofread/model'

/**
 * Review panel of «تدقيق ثم تشكيل». Fully opaque on purpose (solid panel, solid group headers).
 * Nothing is applied until the user accepts items; "accept all" works per group.
 */
const store = useProofreadStore()
const el = ref<HTMLElement | null>(null)
useFocusTrap(el, () => store.finish('cancel'))

const PAGE = 150
const shown = reactive<Record<string, number>>({})
const limit = (c: ProofCategory): number => shown[c] ?? PAGE
const more = (c: ProofCategory): void => {
  shown[c] = limit(c) + PAGE
}
const total = computed(() => store.items.length)
const select = 'rounded border px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800'
const chip =
  'rounded border px-2 py-0.5 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700'
const stateCls = (id: string, which: 'accept' | 'reject'): string =>
  store.decisions[id] === which
    ? which === 'accept'
      ? 'border-mizaj-emerald bg-mizaj-emerald text-white'
      : 'border-red-600 bg-red-600 text-white'
    : ''
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
    <div
      ref="el"
      class="proofread-panel flex max-h-[92vh] w-[56rem] max-w-[96vw] flex-col rounded-lg border border-slate-300 bg-white p-4 text-slate-900 shadow-2xl dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-labelledby="proofread-title"
      data-testid="proofread-dialog"
    >
      <div class="mb-2 flex items-center justify-between">
        <h2 id="proofread-title" class="text-lg font-bold">تدقيق ثم تشكيل</h2>
        <button aria-label="إغلاق" data-testid="proofread-close" @click="store.finish('cancel')">
          ✕
        </button>
      </div>
      <p class="text-xs text-slate-600 dark:text-slate-300">
        الترتيب الصحيح: ١) التدقيق (همزات، إملاء، الياء) ثم ٢) الترقيم ثم ٣) التشكيل. هذه اقتراحات
        فقط؛ لا يتغير أي حرف إلا ما تقبله.
      </p>
      <div class="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <label class="flex items-center gap-1">
          الياء آخر الكلمة
          <select
            :class="select"
            :value="store.yaStyle"
            aria-label="الياء آخر الكلمة"
            data-testid="proofread-ya-style"
            @change="store.setYaStyle(($event.target as HTMLSelectElement).value as YaStyle)"
          >
            <option v-for="[v, label] in YA_STYLE_OPTIONS" :key="v" :value="v">{{ label }}</option>
          </select>
        </label>
        <span data-testid="proofread-summary" class="text-slate-700 dark:text-slate-200">
          {{ total ? `المقبول ${store.acceptedCount} من ${total}` : 'لا توجد اقتراحات' }}
        </span>
        <span v-if="store.loading" class="text-xs text-slate-500" role="status">
          جارٍ التدقيق…
        </span>
      </div>
      <p v-if="store.truncated" class="mt-1 text-xs text-mizaj-amber">
        عدد الاقتراحات كبير؛ عُرض جزء منها فقط. طبّق ثم أعد التدقيق.
      </p>

      <div class="mt-2 min-h-0 flex-1 overflow-y-auto" data-testid="proofread-list">
        <p
          v-if="!total"
          class="rounded border border-slate-200 bg-slate-50 p-4 text-center text-sm dark:border-slate-700 dark:bg-slate-800"
          data-testid="proofread-empty"
        >
          لا توجد اقتراحات تدقيق في هذا النص. يمكنك المتابعة إلى التشكيل.
        </p>
        <section
          v-for="g in store.groups"
          :key="g.category"
          class="mb-3"
          :data-testid="`proofread-group-${g.category}`"
        >
          <header
            class="sticky top-0 z-10 flex items-center gap-2 border-b border-slate-300 bg-slate-100 px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          >
            <h3 class="font-semibold">{{ g.label }}</h3>
            <span class="text-xs text-slate-600 dark:text-slate-300">({{ g.items.length }})</span>
            <span class="flex-1" />
            <button
              :class="chip"
              :data-testid="`proofread-accept-all-${g.category}`"
              @click="store.decideGroup(g.category, 'accept')"
            >
              قبول الكل
            </button>
            <button
              :class="chip"
              :data-testid="`proofread-reject-all-${g.category}`"
              @click="store.decideGroup(g.category, 'reject')"
            >
              رفض الكل
            </button>
          </header>
          <ul class="divide-y divide-slate-200 dark:divide-slate-700">
            <li
              v-for="it in g.items.slice(0, limit(g.category))"
              :key="it.id"
              class="flex items-start gap-2 px-2 py-1 text-sm"
              :data-testid="`proofread-item`"
              :data-category="it.category"
              :data-id="it.id"
            >
              <div class="min-w-0 flex-1">
                <div class="font-editor">
                  <span class="text-slate-500">{{ contextOf(store.text, it).before }}</span>
                  <del class="text-red-700 dark:text-red-300">{{ showChars(it.original) }}</del>
                  ←
                  <ins class="text-emerald-700 no-underline dark:text-emerald-300">{{
                    showChars(store.overrides[it.id] ?? it.replacement)
                  }}</ins>
                  <span class="text-slate-500">{{ contextOf(store.text, it).after }}</span>
                </div>
                <div class="text-xs text-slate-600 dark:text-slate-300">
                  {{ it.reason_ar }}
                  <span v-if="it.alternatives?.length">
                    — أو:
                    <button
                      v-for="a in it.alternatives"
                      :key="a"
                      class="underline"
                      data-testid="proofread-alt"
                      @click="store.choose(it.id, a)"
                    >
                      {{ a }}
                    </button>
                  </span>
                </div>
              </div>
              <button
                :class="[chip, stateCls(it.id, 'accept')]"
                :aria-pressed="store.decisions[it.id] === 'accept'"
                data-testid="proofread-accept"
                @click="store.decide(it.id, 'accept')"
              >
                قبول
              </button>
              <button
                :class="[chip, stateCls(it.id, 'reject')]"
                :aria-pressed="store.decisions[it.id] === 'reject'"
                data-testid="proofread-reject"
                @click="store.decide(it.id, 'reject')"
              >
                رفض
              </button>
            </li>
          </ul>
          <button
            v-if="g.items.length > limit(g.category)"
            :class="[chip, 'mt-1']"
            :data-testid="`proofread-more-${g.category}`"
            @click="more(g.category)"
          >
            عرض المزيد ({{ g.items.length - limit(g.category) }})
          </button>
        </section>
      </div>

      <div
        class="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-700"
      >
        <button
          class="rounded bg-mizaj-emerald px-3 py-1 font-semibold text-white"
          data-testid="proofread-apply-run"
          @click="store.finish('apply_run')"
        >
          طبّق المقبول ثم شكّل
        </button>
        <button
          :class="chip"
          :disabled="!store.acceptedCount"
          data-testid="proofread-apply-only"
          @click="store.finish('apply_only')"
        >
          طبّق دون تشكيل
        </button>
        <button :class="chip" data-testid="proofread-skip-run" @click="store.finish('skip_run')">
          شكّل دون تطبيق
        </button>
        <span class="flex-1" />
        <button :class="chip" data-testid="proofread-cancel" @click="store.finish('cancel')">
          إلغاء
        </button>
      </div>
    </div>
  </div>
</template>
