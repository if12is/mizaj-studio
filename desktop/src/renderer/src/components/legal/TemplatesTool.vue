<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import {
  buildValues,
  errorMap,
  initialFormState,
  PARTY_FIELDS,
  PARTY_LABELS,
  type FormState,
  type PartyState,
  type RenderError,
  type TemplateVar
} from '@renderer/legal/templateForm'
import { useProjectsStore } from '@renderer/stores/projects'
import TemplateEditor from './TemplateEditor.vue'

interface TplSummary {
  id: number
  name: string
  category: string
  jurisdiction: string
  is_sample: boolean
}
interface TplFull extends TplSummary {
  body: string
  vars: TemplateVar[]
}

const props = defineProps<{ openDocument: (id: number) => Promise<void> }>()
const projects = useProjectsStore()
const list = ref<TplSummary[]>([])
const category = ref('')
const current = ref<TplFull | null>(null)
const form = ref<FormState>({})
const preview = ref<{ text: string; ok: boolean; errors: RenderError[] } | null>(null)
const errs = computed(() => errorMap(preview.value?.errors ?? []))
const editing = ref<null | { template?: TplFull }>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
const categories = computed(() => [...new Set(list.value.map((t) => t.category).filter(Boolean))])

async function load(): Promise<void> {
  const q = category.value ? `?category=${encodeURIComponent(category.value)}` : ''
  try {
    list.value = await useApi().get<TplSummary[]>(`/api/legal/templates${q}`, true)
  } catch {
    list.value = []
  }
}
onMounted(() => void load())
watch(category, () => void load())

async function open(id: number): Promise<void> {
  current.value = await useApi().get<TplFull>(`/api/legal/templates/${id}`)
  form.value = initialFormState(current.value.vars)
  void render()
}

let timer: ReturnType<typeof setTimeout> | null = null
async function render(): Promise<void> {
  const t = current.value
  if (!t) return
  try {
    preview.value = await useApi().request(
      'POST',
      `/api/legal/templates/${t.id}/render`,
      { values: buildValues(t.vars, form.value) },
      true
    )
  } catch {
    preview.value = null
  }
}
watch(
  form,
  () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void render(), 400)
  },
  { deep: true }
)

async function create(): Promise<void> {
  const t = current.value
  if (!t || !preview.value?.ok) return
  const pid = projects.currentProjectId ?? projects.projects[0]?.id
  if (pid === undefined) return notify('أنشئ مشروعاً أولاً.')
  const d = await projects.createDocument(pid, t.name, preview.value.text)
  notify('تم إنشاء المستند.', { kind: 'success' })
  current.value = null
  await props.openDocument(d.id)
}

async function remove(t: TplSummary): Promise<void> {
  if (!window.confirm(`حذف القالب «${t.name}»؟`)) return
  await useApi().del(`/api/legal/templates/${t.id}`)
  await load()
}
async function edit(id: number, copy = false): Promise<void> {
  const t = await useApi().get<TplFull>(`/api/legal/templates/${id}`)
  editing.value = {
    template: copy ? { ...t, id: undefined as unknown as number, name: t.name + ' (نسخة)' } : t
  }
}
async function exportAll(): Promise<void> {
  const data = await useApi().get('/api/legal/templates/export')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  )
  a.download = 'mizaj-templates.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
async function importFile(ev: Event): Promise<void> {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const parsed = JSON.parse(await f.text()) as { templates?: unknown[] }
    if (!Array.isArray(parsed.templates)) throw new Error('bad')
    const r = await useApi().post<{ imported: number }>('/api/legal/templates/import', {
      templates: parsed.templates
    })
    notify(`تم استيراد ${r.imported} قالب.`, { kind: 'success' })
    await load()
  } catch {
    notify('ملف القوالب غير صالح.')
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}
const party = (name: string): PartyState => form.value[name] as PartyState
const str = (name: string): string => form.value[name] as string
const setStr = (name: string, v: string): void => {
  form.value[name] = v
}
</script>

<template>
  <div data-testid="templates-tool">
    <TemplateEditor
      v-if="editing"
      :template="editing.template"
      @saved="(editing = null), load()"
      @cancel="editing = null"
    />
    <div v-else-if="current" class="space-y-2 p-3 text-sm" data-testid="tpl-form">
      <button class="text-xs text-mizaj-emerald" @click="current = null">← القوالب</button>
      <h3 class="font-bold">{{ current.name }}</h3>
      <p
        v-if="current.is_sample"
        class="rounded bg-mizaj-amber/20 px-2 py-1 text-xs text-mizaj-amber"
        data-testid="tpl-sample-notice"
      >
        يحتاج مراجعة قانونية: نموذج تعليمي عام وليس استشارة قانونية.
      </p>
      <div v-for="v in current.vars" :key="v.name" :data-var="v.name" class="space-y-1">
        <label class="block font-semibold">
          {{ v.label || v.name }}<span v-if="v.required !== false" class="text-red-500"> *</span>
        </label>
        <template v-if="v.type === 'party'">
          <input
            v-for="f in PARTY_FIELDS"
            :key="f"
            v-model="party(v.name)[f]"
            :class="field"
            class="w-full"
            :placeholder="PARTY_LABELS[f]"
            :data-testid="`tpl-field-${v.name}-${f}`"
          />
        </template>
        <select
          v-else-if="v.type === 'choice'"
          :class="field"
          class="w-full"
          :value="str(v.name)"
          :data-testid="`tpl-field-${v.name}`"
          @change="setStr(v.name, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">—</option>
          <option v-for="c in v.choices ?? []" :key="c" :value="c">{{ c }}</option>
        </select>
        <input
          v-else
          :type="v.type === 'date' ? 'date' : 'text'"
          :inputmode="v.type === 'money' || v.type === 'number' ? 'decimal' : undefined"
          :class="field"
          class="w-full"
          :value="str(v.name)"
          :data-testid="`tpl-field-${v.name}`"
          @input="setStr(v.name, ($event.target as HTMLInputElement).value)"
        />
        <p v-if="errs[v.name]" class="text-xs text-red-500" data-testid="tpl-field-error">
          {{ errs[v.name] }}
        </p>
      </div>
      <h4 class="font-semibold">معاينة</h4>
      <pre
        class="font-editor max-h-64 overflow-auto whitespace-pre-wrap rounded border p-2 dark:border-slate-600"
        dir="rtl"
        data-testid="tpl-preview"
        >{{ preview?.text }}</pre
      >
      <button
        class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
        :disabled="!preview?.ok"
        data-testid="tpl-create"
        @click="create"
      >
        إنشاء مستند
      </button>
    </div>
    <div v-else class="space-y-2 p-3 text-sm">
      <div class="flex flex-wrap gap-2">
        <select v-model="category" :class="field" data-testid="tpl-category">
          <option value="">كل التصنيفات</option>
          <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
        </select>
        <button
          class="rounded border px-2 dark:border-slate-600"
          data-testid="tpl-new"
          @click="editing = {}"
        >
          قالب جديد
        </button>
        <button
          class="rounded border px-2 dark:border-slate-600"
          data-testid="tpl-export"
          @click="exportAll"
        >
          تصدير JSON
        </button>
        <button
          class="rounded border px-2 dark:border-slate-600"
          data-testid="tpl-import"
          @click="fileInput?.click()"
        >
          استيراد JSON
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          class="hidden"
          data-testid="tpl-import-file"
          @change="importFile"
        />
      </div>
      <ul class="space-y-1">
        <li
          v-for="t in list"
          :key="t.id"
          class="flex items-center justify-between rounded border p-2 dark:border-slate-600"
          data-testid="tpl-item"
          :data-sample="t.is_sample"
        >
          <button class="text-start" data-testid="tpl-open" @click="open(t.id)">
            <b>{{ t.name }}</b>
            <span class="block text-xs text-slate-500">{{ t.category }}</span>
            <span v-if="t.is_sample" class="text-xs text-mizaj-amber">يحتاج مراجعة قانونية</span>
          </button>
          <span class="flex gap-2 text-xs">
            <button
              v-if="!t.is_sample"
              class="text-mizaj-emerald"
              data-testid="tpl-edit"
              @click="edit(t.id)"
            >
              تعديل
            </button>
            <button v-else class="text-mizaj-emerald" @click="edit(t.id, true)">نسخ</button>
            <button v-if="!t.is_sample" class="text-red-500" @click="remove(t)">حذف</button>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
