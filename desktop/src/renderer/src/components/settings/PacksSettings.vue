<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue'
import { usePacksStore, type ExportForm } from '@renderer/stores/packs'
import {
  DATA_KINDS,
  GROUP_TITLE,
  KIND_HELP,
  KIND_LABEL,
  reasonLabel,
  summaryText,
  valueText,
  type Choice,
  type PlanGroups,
  type PlanItem
} from '@renderer/packs/labels'

const packs = usePacksStore()
const form = reactive<ExportForm>({
  kinds: ['dictionary', 'glossary', 'templates'],
  name: '',
  version: '1.0.0',
  license: 'CC0-1.0',
  author: '',
  attribution: '',
  description: '',
  include_sample_templates: false,
  include_private_settings: false
})
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
const btn =
  'rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700'

onMounted(() => void packs.loadHistory())

function toggleKind(k: string, on: boolean): void {
  form.kinds = on ? [...new Set([...form.kinds, k])] : form.kinds.filter((x) => x !== k)
}
function toggleImportKind(k: string, on: boolean): void {
  packs.selectedKinds = on
    ? [...new Set([...packs.selectedKinds, k])]
    : packs.selectedKinds.filter((x) => x !== k)
}
const groupKeys = ['conflicts', 'updates', 'adds', 'skips'] as const
const blockingConflicts = computed(() => {
  const p = packs.preview
  if (!p) return 0
  return packs.selectedKinds.reduce((n, k) => n + (p.items[k]?.conflicts.length ?? 0), 0)
})
function choiceOf(kind: string, it: PlanItem): Choice {
  return packs.choices[kind]?.[it.key] ?? (it.action === 'update' ? 'override' : 'keep')
}
function planOf(kind: string): PlanGroups | undefined {
  return packs.preview?.items[kind]
}
const statusLabel: Record<string, string> = { applied: 'مُطبَّق', undone: 'مُتراجَع عنه' }
</script>

<template>
  <div class="space-y-5 text-sm" data-testid="packs-settings">
    <p class="text-xs text-slate-500">
      الحزم ملفات (‎.mizajpack‎) تُصدَّر وتُستورد بين المستخدمين يدوياً؛ لا يوجد خادم ولا رفع. لا
      يغادر جهازك شيء.
    </p>

    <section class="space-y-2" data-testid="packs-export">
      <h3 class="font-semibold">تصدير حزمة</h3>
      <fieldset>
        <legend class="mb-1">ما الذي تريد تصديره؟</legend>
        <div class="space-y-1">
          <label v-for="k in DATA_KINDS" :key="k" class="flex items-start gap-2">
            <input
              type="checkbox"
              :checked="form.kinds.includes(k)"
              :data-testid="`pack-kind-${k}`"
              @change="toggleKind(k, ($event.target as HTMLInputElement).checked)"
            />
            <span>
              {{ KIND_LABEL[k] }}
              <span class="block text-xs text-slate-500">{{ KIND_HELP[k] }}</span>
            </span>
          </label>
        </div>
      </fieldset>
      <div class="grid grid-cols-2 items-center gap-2">
        <label for="pk-name">اسم الحزمة <span class="text-red-500">*</span></label>
        <input id="pk-name" v-model="form.name" :class="field" data-testid="pack-name" />
        <label for="pk-version">الإصدار</label>
        <input
          id="pk-version"
          v-model="form.version"
          :class="field"
          dir="ltr"
          data-testid="pack-version-input"
        />
        <label for="pk-license">الترخيص <span class="text-red-500">*</span></label>
        <input
          id="pk-license"
          v-model="form.license"
          :class="field"
          dir="ltr"
          data-testid="pack-license"
        />
        <label for="pk-author">المؤلف</label>
        <input id="pk-author" v-model="form.author" :class="field" data-testid="pack-author" />
        <label for="pk-attr">الإسناد (المصدر / الشكر)</label>
        <input
          id="pk-attr"
          v-model="form.attribution"
          :class="field"
          data-testid="pack-attribution"
        />
        <label for="pk-desc">الوصف</label>
        <textarea
          id="pk-desc"
          v-model="form.description"
          :class="field"
          rows="2"
          data-testid="pack-description"
        />
      </div>
      <label class="flex items-center gap-2">
        <input
          v-model="form.include_sample_templates"
          type="checkbox"
          data-testid="pack-include-samples"
        />
        تضمين القوالب التعليمية المدمجة
      </label>
      <label v-if="form.kinds.includes('settings')" class="flex items-start gap-2">
        <input
          v-model="form.include_private_settings"
          type="checkbox"
          data-testid="pack-include-private"
        />
        <span>
          تضمين إعدادات خاصة
          <span class="block text-xs text-mizaj-amber" data-testid="pack-private-warning">
            تنبيه: قد تكشف الإعدادات الخاصة معلومات عن جهازك؛ لا تشاركها مع غيرك دون مراجعة.
          </span>
        </span>
      </label>
      <button
        class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
        :disabled="packs.busy"
        data-testid="pack-export"
        @click="packs.exportPack(form)"
      >
        تصدير الحزمة…
      </button>
    </section>

    <section class="space-y-2 border-t pt-3 dark:border-slate-700" data-testid="packs-import">
      <h3 class="font-semibold">استيراد حزمة</h3>
      <button
        :class="btn"
        :disabled="packs.busy"
        data-testid="pack-import"
        @click="packs.chooseAndPreview()"
      >
        اختيار ملف حزمة…
      </button>

      <div
        v-if="packs.preview"
        class="space-y-3 rounded border p-3 dark:border-slate-600"
        data-testid="pack-preview"
      >
        <div>
          <p class="font-bold" data-testid="pack-preview-name">{{ packs.preview.name }}</p>
          <p class="text-xs text-slate-500">
            الإصدار {{ packs.preview.version }} — الترخيص:
            <span dir="ltr" data-testid="pack-preview-license">{{ packs.preview.license }}</span>
            <span v-if="packs.preview.author"> — المؤلف: {{ packs.preview.author }}</span>
          </p>
          <p v-if="packs.preview.attribution" class="text-xs text-slate-500">
            الإسناد: {{ packs.preview.attribution }}
          </p>
          <p v-if="packs.preview.description" class="text-xs">{{ packs.preview.description }}</p>
        </div>
        <p v-if="packs.preview.models" class="text-mizaj-amber" data-testid="pack-preview-models">
          تحتوي الحزمة نماذج ({{ packs.preview.models.files }} ملف)؛ تطبيقها يستبدل النماذج الحالية
          ولا يمكن التراجع عنها.
        </p>
        <div v-for="k in packs.preview.kinds" :key="k" :data-testid="`pack-kind-section-${k}`">
          <label class="flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              :checked="packs.selectedKinds.includes(k)"
              :data-testid="`pack-import-kind-${k}`"
              @change="toggleImportKind(k, ($event.target as HTMLInputElement).checked)"
            />
            {{ KIND_LABEL[k] ?? k }}
            <span v-if="packs.preview.summary[k]" class="text-xs font-normal text-slate-500">
              ({{ summaryText(packs.preview.summary[k]) }})
            </span>
          </label>
          <template v-if="planOf(k) && packs.selectedKinds.includes(k)">
            <template v-for="g in groupKeys" :key="g">
              <details
                v-if="planOf(k)![g].length"
                class="mt-1 ps-5"
                :open="g === 'conflicts'"
                :data-testid="`pack-group-${k}-${g}`"
              >
                <summary class="cursor-pointer">
                  {{ GROUP_TITLE[g] }} ({{ planOf(k)![g].length }})
                </summary>
                <ul class="mt-1 max-h-48 space-y-1 overflow-auto">
                  <li
                    v-for="it in planOf(k)![g]"
                    :key="it.key"
                    class="rounded border p-1 text-xs dark:border-slate-600"
                    :data-testid="`pack-item-${g}`"
                  >
                    <div class="font-editor text-sm">{{ it.key }}</div>
                    <div class="text-slate-500">{{ reasonLabel(it.reason) }}</div>
                    <div v-if="it.incoming" class="font-editor">
                      الوارد: {{ valueText(it.incoming) }}
                    </div>
                    <div v-if="it.current" class="font-editor">
                      الحالي: {{ valueText(it.current) }}
                    </div>
                    <div v-if="g === 'conflicts' || g === 'updates'" class="mt-1 flex gap-3">
                      <label class="flex items-center gap-1">
                        <input
                          type="radio"
                          :name="`c-${k}-${it.key}`"
                          :checked="choiceOf(k, it) === 'keep'"
                          data-testid="pack-choice-keep"
                          @change="packs.setChoice(k, it.key, 'keep')"
                        />
                        إبقاء الحالي
                      </label>
                      <label class="flex items-center gap-1">
                        <input
                          type="radio"
                          :name="`c-${k}-${it.key}`"
                          :checked="choiceOf(k, it) === 'override'"
                          data-testid="pack-choice-override"
                          @change="packs.setChoice(k, it.key, 'override')"
                        />
                        استبدال بالوارد
                      </label>
                      <label
                        v-if="it.options?.includes('duplicate')"
                        class="flex items-center gap-1"
                      >
                        <input
                          type="radio"
                          :name="`c-${k}-${it.key}`"
                          :checked="choiceOf(k, it) === 'duplicate'"
                          data-testid="pack-choice-duplicate"
                          @change="packs.setChoice(k, it.key, 'duplicate')"
                        />
                        الاحتفاظ بالاثنين (نسخة)
                      </label>
                    </div>
                  </li>
                </ul>
              </details>
            </template>
          </template>
        </div>
        <p v-if="blockingConflicts" class="text-xs text-slate-500">
          التعارضات تُبقي نسختك الحالية ما لم تختر غير ذلك.
        </p>
        <div class="flex gap-2">
          <button
            class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
            :disabled="packs.busy || !packs.selectedKinds.length"
            data-testid="pack-apply-v2"
            @click="packs.apply()"
          >
            تطبيق الاستيراد
          </button>
          <button :class="btn" data-testid="pack-preview-cancel" @click="packs.cancelPreview()">
            إلغاء
          </button>
        </div>
      </div>
    </section>

    <p
      v-if="packs.message"
      :class="packs.message.ok ? 'text-mizaj-emerald' : 'text-red-500'"
      role="status"
      data-testid="pack-message"
    >
      {{ packs.message.text }}
    </p>

    <section class="space-y-2 border-t pt-3 dark:border-slate-700" data-testid="packs-history">
      <h3 class="font-semibold">سجل الاستيراد</h3>
      <p v-if="!packs.history.length" class="text-slate-500" data-testid="pack-history-empty">
        لم تستورد أي حزمة بعد.
      </p>
      <ul class="space-y-1">
        <li
          v-for="h in packs.history"
          :key="h.id"
          class="flex items-center justify-between rounded border p-2 dark:border-slate-600"
          data-testid="pack-history-item"
          :data-status="h.status"
        >
          <span>
            <b>{{ h.name }}</b>
            <span class="text-xs text-slate-500">
              — {{ KIND_LABEL[h.kind] ?? h.kind }} — {{ h.created_at }} —
              {{ statusLabel[h.status] ?? h.status }}
            </span>
          </span>
          <button
            v-if="h.status !== 'undone' && h.kind !== 'models'"
            :class="btn"
            :disabled="packs.busy"
            data-testid="pack-undo"
            @click="packs.undo(h.id)"
          >
            تراجع
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
