<script setup lang="ts">
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { rowsToVars, varsToRows, type TemplateVar, type VarRow } from '@renderer/legal/templateForm'

const props = defineProps<{
  template?: {
    id?: number
    name: string
    category: string
    jurisdiction: string
    body: string
    vars: TemplateVar[]
  }
}>()
const emit = defineEmits<{ (e: 'saved'): void; (e: 'cancel'): void }>()
const t = props.template
const name = ref(t?.name ?? '')
const category = ref(t?.category ?? '')
const jurisdiction = ref(t?.jurisdiction ?? '')
const body = ref(t?.body ?? '')
const rows = ref<VarRow[]>(varsToRows(t?.vars ?? []))
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
const types = ['text', 'party', 'money', 'date', 'number', 'choice']

const addRow = (): void => {
  rows.value.push({
    name: '',
    type: 'text',
    required: true,
    label: '',
    default: '',
    choices: '',
    currency: ''
  })
}
async function save(): Promise<void> {
  const payload = {
    name: name.value.trim(),
    category: category.value.trim(),
    jurisdiction: jurisdiction.value.trim(),
    body: body.value,
    vars: rowsToVars(rows.value),
    is_sample: false
  }
  if (!payload.name || !payload.body.trim()) return notify('الاسم والنص مطلوبان.')
  try {
    if (t?.id) await useApi().put(`/api/legal/templates/${t.id}`, payload)
    else await useApi().post('/api/legal/templates', payload)
    notify('تم حفظ القالب.', { kind: 'success' })
    emit('saved')
  } catch {
    /* validation toast shown */
  }
}
</script>

<template>
  <div class="space-y-2 p-3 text-sm" data-testid="tpl-editor">
    <input
      v-model="name"
      :class="field"
      class="w-full"
      aria-label="اسم القالب"
      placeholder="اسم القالب"
      data-testid="tpl-edit-name"
    />
    <div class="grid grid-cols-2 gap-2">
      <input v-model="category" :class="field" aria-label="التصنيف" placeholder="التصنيف" />
      <input
        v-model="jurisdiction"
        :class="field"
        aria-label="الاختصاص القضائي"
        placeholder="الاختصاص القضائي"
      />
    </div>
    <textarea
      v-model="body"
      rows="8"
      :class="field"
      class="w-full font-mono"
      dir="rtl"
      aria-label="نص القالب. مثال: {{ party.name }} ، {{ amount:rent }} ، {{ date:start }}"
      placeholder="نص القالب. مثال: {{ party.name }} ، {{ amount:rent }} ، {{ date:start }}"
      data-testid="tpl-edit-body"
    />
    <h4 class="font-semibold">المتغيّرات</h4>
    <div
      v-for="(r, i) in rows"
      :key="i"
      class="grid grid-cols-6 items-center gap-1"
      data-testid="tpl-var-row"
    >
      <input
        v-model="r.name"
        :class="field"
        class="col-span-2"
        aria-label="الاسم"
        placeholder="الاسم"
      />
      <select v-model="r.type" :class="field" aria-label="نوع المتغير">
        <option v-for="ty in types" :key="ty" :value="ty">{{ ty }}</option>
      </select>
      <input
        v-model="r.label"
        :class="field"
        class="col-span-2"
        aria-label="التسمية"
        placeholder="التسمية"
      />
      <button class="text-red-500" @click="rows.splice(i, 1)">حذف</button>
      <input
        v-if="r.type === 'choice'"
        v-model="r.choices"
        :class="field"
        class="col-span-6"
        aria-label="الخيارات مفصولة بفاصلة"
        placeholder="الخيارات مفصولة بفاصلة"
      />
      <input
        v-if="r.type === 'money'"
        v-model="r.currency"
        :class="field"
        class="col-span-3"
        aria-label="العملة (SAR)"
        placeholder="العملة (SAR)"
      />
      <input
        v-model="r.default"
        :class="field"
        class="col-span-3"
        aria-label="القيمة الافتراضية"
        placeholder="القيمة الافتراضية"
      />
      <label class="col-span-6 flex items-center gap-1"
        ><input v-model="r.required" type="checkbox" /> مطلوب</label
      >
    </div>
    <button
      class="rounded border px-2 py-1 dark:border-slate-600"
      data-testid="tpl-add-var"
      @click="addRow"
    >
      + متغيّر
    </button>
    <div class="flex gap-2">
      <button
        class="rounded bg-mizaj-emerald px-3 py-1 text-white"
        data-testid="tpl-save"
        @click="save"
      >
        حفظ
      </button>
      <button class="rounded border px-3 py-1 dark:border-slate-600" @click="emit('cancel')">
        إلغاء
      </button>
    </div>
  </div>
</template>
