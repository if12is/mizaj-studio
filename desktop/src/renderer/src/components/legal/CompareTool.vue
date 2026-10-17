<script setup lang="ts">
import { computed, ref } from 'vue'
import { CATEGORY_AR, sideSegments, visibleRows, type Segment } from '@renderer/legal/tools'
import { useCompareStore } from '@renderer/stores/legalTools'
import { useEditorStore } from '@renderer/stores/editor'
import { useProjectsStore } from '@renderer/stores/projects'

const cmp = useCompareStore()
const editor = useEditorStore()
const projects = useProjectsStore()
const srcA = ref('current')
const srcB = ref('')
const pasteA = ref('')
const pasteB = ref('')
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'

const docs = computed(() =>
  projects.projects.flatMap((p) =>
    (projects.documents[p.id] ?? []).map((d) => ({ id: d.id, label: `${p.name} / ${d.title}` }))
  )
)

type Side = { text?: string; doc?: number }
function side(src: string, paste: string): Side {
  if (src === 'current') return { text: editor.accessor?.getText() ?? '' }
  if (src === 'paste') return { text: paste }
  return { doc: Number(src.replace('doc:', '')) }
}
const ready = computed(() => !!srcB.value && (srcA.value !== 'current' || !!editor.accessor))
async function run(): Promise<void> {
  await cmp.run(side(srcA.value, pasteA.value), side(srcB.value, pasteB.value))
}

const rows = computed(() =>
  cmp.result
    ? visibleRows(cmp.result.aligned, { showFormat: cmp.showFormat, showEqual: cmp.showEqual })
    : []
)
function segs(r: NonNullable<typeof cmp.result>['aligned'][number], which: 'a' | 'b'): Segment[] {
  return sideSegments(r[which], which, cmp.result!.hunks, r.hunks, cmp.showFormat)
}
const segClass: Record<Segment['kind'], string> = {
  same: '',
  change: 'rounded bg-yellow-300/60 px-0.5 dark:bg-yellow-500/40',
  format: 'rounded bg-sky-300/50 px-0.5 dark:bg-sky-500/30'
}
const statusLabel: Record<string, string> = {
  changed: 'معدَّلة',
  added: 'مضافة',
  removed: 'محذوفة',
  format_only: 'شكل فقط',
  equal: 'متطابقة'
}
</script>

<template>
  <div class="space-y-3 p-3 text-sm" data-testid="compare-tool">
    <p class="text-xs text-slate-500">
      تتجاهل المقارنة التشكيل والتطويل والهمزات وشكل الأرقام، وتبرز تغييرات المبالغ والتواريخ
      والأطراف والالتزامات والنفي.
    </p>
    <div class="grid grid-cols-2 gap-2">
      <label class="block">
        <span class="font-semibold">النسخة الأولى</span>
        <select v-model="srcA" :class="field" class="mt-1 w-full" data-testid="cmp-src-a">
          <option value="current">المستند المفتوح</option>
          <option value="paste">لصق نص</option>
          <option v-for="d in docs" :key="d.id" :value="`doc:${d.id}`">{{ d.label }}</option>
        </select>
      </label>
      <label class="block">
        <span class="font-semibold">النسخة الثانية</span>
        <select v-model="srcB" :class="field" class="mt-1 w-full" data-testid="cmp-src-b">
          <option value="" disabled>اختر…</option>
          <option value="paste">لصق نص</option>
          <option v-for="d in docs" :key="d.id" :value="`doc:${d.id}`">{{ d.label }}</option>
        </select>
      </label>
      <textarea
        v-if="srcA === 'paste'"
        v-model="pasteA"
        :class="field"
        rows="3"
        aria-label="النص الأول"
        data-testid="cmp-paste-a"
      />
      <span v-else />
      <textarea
        v-if="srcB === 'paste'"
        v-model="pasteB"
        :class="field"
        rows="3"
        aria-label="النص الثاني"
        data-testid="cmp-paste-b"
      />
    </div>
    <button
      class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
      :disabled="cmp.running || !ready"
      data-testid="cmp-run"
      @click="run"
    >
      قارن
    </button>

    <template v-if="cmp.result">
      <p v-if="cmp.result.identical" class="text-mizaj-emerald" data-testid="cmp-identical">
        النسختان متطابقتان من حيث المضمون.
      </p>
      <section data-testid="cmp-summary">
        <h3 class="font-semibold">الفروق الجوهرية</h3>
        <p v-if="!cmp.result.summary.substantive.length" class="text-slate-500">
          لا فروق جوهرية مصنَّفة.
        </p>
        <ul class="flex flex-wrap gap-2">
          <li
            v-for="(n, c) in cmp.result.summary.by_category"
            :key="c"
            class="rounded bg-mizaj-amber/20 px-2 py-0.5 text-mizaj-amber"
            data-testid="cmp-category"
            :data-category="c"
          >
            {{ CATEGORY_AR[c] ?? c }}: {{ n }}
          </li>
        </ul>
        <ul class="mt-1 space-y-0.5 text-xs">
          <li
            v-for="s in cmp.result.summary.substantive"
            :key="s.hunk"
            data-testid="cmp-substantive"
          >
            <span class="font-editor line-through">{{ s.a_text || '∅' }}</span>
            ←
            <span class="font-editor font-semibold">{{ s.b_text || '∅' }}</span>
            <span class="text-slate-500">
              ({{ s.categories.map((c) => CATEGORY_AR[c] ?? c).join('، ') }})</span
            >
          </li>
        </ul>
      </section>
      <div class="flex flex-wrap gap-4">
        <label class="flex items-center gap-1">
          <input v-model="cmp.showFormat" type="checkbox" data-testid="cmp-show-format" />
          إظهار فروق الشكل فقط ({{ cmp.result.counts.format_only ?? 0 }})
        </label>
        <label class="flex items-center gap-1">
          <input v-model="cmp.showEqual" type="checkbox" data-testid="cmp-show-equal" />
          إظهار الفقرات المتطابقة
        </label>
      </div>
      <div class="space-y-2" data-testid="cmp-rows">
        <div
          v-for="(r, n) in rows"
          :key="n"
          class="grid grid-cols-2 gap-2 rounded border p-2 dark:border-slate-600"
          data-testid="cmp-row"
          :data-status="r.status"
        >
          <div class="font-editor" data-testid="cmp-side-a">
            <span
              v-for="(s, k) in segs(r, 'a')"
              :key="k"
              :class="segClass[s.kind]"
              :data-kind="s.kind"
              >{{ s.text }}</span
            >
            <em v-if="!r.a" class="text-slate-400">— غير موجودة —</em>
          </div>
          <div class="font-editor" data-testid="cmp-side-b">
            <span
              v-for="(s, k) in segs(r, 'b')"
              :key="k"
              :class="segClass[s.kind]"
              :data-kind="s.kind"
              >{{ s.text }}</span
            >
            <em v-if="!r.b" class="text-slate-400">— غير موجودة —</em>
          </div>
          <span class="col-span-2 text-xs text-slate-500">{{ statusLabel[r.status] }}</span>
        </div>
        <p v-if="!rows.length" class="text-slate-500" data-testid="cmp-no-rows">لا فقرات للعرض.</p>
      </div>
    </template>
  </div>
</template>
