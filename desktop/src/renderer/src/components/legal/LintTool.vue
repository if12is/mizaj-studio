<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { MODALITY_LABEL, SEVERITY_LABEL, groupByRule, modalityCounts } from '@renderer/legal/tools'
import { useLintStore } from '@renderer/stores/legalTools'

const lint = useLintStore()
onMounted(() => void lint.loadRules())
const groups = computed(() => groupByRule(lint.issues))
const title = (rule: string): string => lint.rules.find((r) => r.id === rule)?.title_ar ?? rule
const modalities = computed(() => modalityCounts(lint.result?.modalities ?? []))
const sevClass: Record<string, string> = {
  error: 'text-red-500',
  warning: 'text-mizaj-amber',
  info: 'text-slate-500'
}
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
</script>

<template>
  <div class="space-y-3 p-3 text-sm" data-testid="lint-tool">
    <p class="text-xs text-slate-500">
      فحص مساعد للصياغة القانونية؛ ليس حكماً قانونياً وقد يُظهر إيجابيات كاذبة.
    </p>
    <label class="block">
      <span class="font-semibold">نوع المستند (لقائمة تحقق الأقسام)</span>
      <select v-model="lint.docType" :class="field" class="mt-1 w-full" data-testid="lint-doc-type">
        <option value="">بدون قائمة تحقق</option>
        <option v-for="d in lint.docTypes" :key="d.id" :value="d.id">{{ d.title_ar }}</option>
      </select>
    </label>
    <details data-testid="lint-rules">
      <summary class="cursor-pointer font-semibold">
        القواعد ({{ lint.rules.length - lint.disabled.length }} مفعّلة)
      </summary>
      <ul class="mt-1 space-y-1">
        <li v-for="r in lint.rules" :key="r.id">
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              :checked="!lint.disabled.includes(r.id)"
              :data-testid="`lint-rule-${r.id}`"
              @change="lint.toggleRule(r.id, ($event.target as HTMLInputElement).checked)"
            />
            {{ r.title_ar }}
          </label>
        </li>
      </ul>
    </details>
    <button
      class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
      :disabled="lint.running"
      data-testid="lint-run"
      @click="lint.run()"
    >
      فحص الصياغة
    </button>

    <template v-if="lint.result">
      <p v-if="!lint.issues.length" class="text-mizaj-emerald" data-testid="lint-clean">
        لم تُرصد ملاحظات صياغة.
      </p>
      <section v-for="g in groups" :key="g.rule" :data-rule="g.rule" data-testid="lint-group">
        <h3 class="font-semibold">{{ title(g.rule) }} ({{ g.items.length }})</h3>
        <ul class="mt-1 space-y-1">
          <li
            v-for="i in g.items"
            :key="i.id"
            class="rounded border p-2 dark:border-slate-600"
            data-testid="lint-issue"
          >
            <button class="block w-full text-start" data-testid="lint-jump" @click="lint.jump(i)">
              <span class="font-editor">{{ i.text.slice(0, 60) }}</span>
              <span class="block text-xs" :class="sevClass[i.severity]">
                {{ SEVERITY_LABEL[i.severity] }}: {{ i.message_ar }}
              </span>
            </button>
          </li>
        </ul>
      </section>

      <section data-testid="lint-modalities">
        <h3 class="font-semibold">ملخص الصيغ (التزام / إذن / حظر)</h3>
        <p class="text-xs text-slate-500">عدد الجمل التي تحمل كل صيغة:</p>
        <ul class="flex flex-wrap gap-3">
          <li v-for="m in modalities" :key="m.kind" :data-kind="m.kind" data-testid="lint-modality">
            {{ MODALITY_LABEL[m.kind] }}: <b>{{ m.count }}</b>
          </li>
        </ul>
      </section>

      <section v-if="lint.result.structure" data-testid="lint-structure">
        <h3 class="font-semibold">قائمة تحقق: {{ lint.result.structure.title_ar }}</h3>
        <ul class="space-y-0.5">
          <li
            v-for="s in lint.result.structure.found"
            :key="s.id"
            class="text-mizaj-emerald"
            data-testid="lint-structure-found"
          >
            ✓ {{ s.label_ar }}
          </li>
          <li
            v-for="s in lint.result.structure.missing"
            :key="s.id"
            class="text-mizaj-amber"
            data-testid="lint-structure-missing"
          >
            ✗ {{ s.label_ar }} (غير موجود)
          </li>
        </ul>
        <p class="text-xs text-slate-500">{{ lint.result.structure.note_ar }}</p>
      </section>
      <p class="text-xs text-slate-500">{{ lint.result.disclaimer_ar }}</p>
    </template>
  </div>
</template>
