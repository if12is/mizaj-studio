<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'

interface Entry {
  id: number | null
  term: string
  diacritized: string
  preferred: string
  avoid: string[]
  definition: string
  builtin: boolean
}
const entries = ref<Entry[]>([])
const q = ref('')
const draft = ref({
  id: null as number | null,
  term: '',
  diacritized: '',
  preferred: '',
  avoid: '',
  definition: ''
})
const fileInput = ref<HTMLInputElement | null>(null)
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'

async function load(): Promise<void> {
  try {
    entries.value = await useApi().get<Entry[]>(
      `/api/legal/glossary${q.value.trim() ? `?q=${encodeURIComponent(q.value.trim())}` : ''}`,
      true
    )
  } catch {
    entries.value = []
  }
}
onMounted(() => void load())

const reset = (): void => {
  draft.value = { id: null, term: '', diacritized: '', preferred: '', avoid: '', definition: '' }
}
async function save(): Promise<void> {
  const d = draft.value
  if (!d.term.trim()) return
  const body = {
    term: d.term.trim(),
    diacritized: d.diacritized.trim() || d.term.trim(),
    preferred: d.preferred.trim(),
    avoid: d.avoid
      .split(/[,،]/)
      .map((x) => x.trim())
      .filter(Boolean),
    definition: d.definition.trim()
  }
  try {
    if (d.id !== null) await useApi().put(`/api/legal/glossary/${d.id}`, body)
    else await useApi().post('/api/legal/glossary', body)
    reset()
    await load()
  } catch {
    /* toast shown */
  }
}
function edit(e: Entry): void {
  draft.value = {
    id: e.id,
    term: e.term,
    diacritized: e.diacritized,
    preferred: e.preferred,
    avoid: e.avoid.join('، '),
    definition: e.definition
  }
}
async function remove(e: Entry): Promise<void> {
  if (e.id === null) return
  await useApi().del(`/api/legal/glossary/${e.id}`)
  await load()
}
async function exportAll(): Promise<void> {
  const data = await useApi().get('/api/legal/glossary/export')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  )
  a.download = 'mizaj-glossary.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
async function importFile(ev: Event): Promise<void> {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const parsed = JSON.parse(await f.text()) as { entries?: unknown[] }
    if (!Array.isArray(parsed.entries)) throw new Error('bad')
    const r = await useApi().post<{ imported: number; updated: number }>(
      '/api/legal/glossary/import',
      {
        entries: parsed.entries
      }
    )
    notify(`تم الاستيراد: ${r.imported} جديد، ${r.updated} محدّث`, { kind: 'success' })
    await load()
  } catch {
    notify('ملف المعجم غير صالح.')
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}
</script>

<template>
  <div class="space-y-3" data-testid="glossary-panel">
    <div class="flex gap-2">
      <input
        v-model="q"
        :class="field"
        class="flex-1"
        placeholder="بحث..."
        data-testid="gloss-search"
        @input="load"
      />
      <button
        class="rounded border px-2 text-sm dark:border-slate-600"
        data-testid="gloss-export"
        @click="exportAll"
      >
        تصدير JSON
      </button>
      <button
        class="rounded border px-2 text-sm dark:border-slate-600"
        data-testid="gloss-import"
        @click="fileInput?.click()"
      >
        استيراد JSON
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        class="hidden"
        data-testid="gloss-import-file"
        @change="importFile"
      />
    </div>
    <form class="grid grid-cols-2 gap-2" @submit.prevent="save">
      <input v-model="draft.term" :class="field" placeholder="المصطلح" data-testid="gloss-term" />
      <input
        v-model="draft.diacritized"
        :class="field"
        placeholder="الصيغة المشكولة"
        data-testid="gloss-diacritized"
      />
      <input v-model="draft.preferred" :class="field" placeholder="الصيغة المفضلة" />
      <input
        v-model="draft.avoid"
        :class="field"
        placeholder="صيغ يُنصح بتجنبها (مفصولة بفاصلة)"
        data-testid="gloss-avoid"
      />
      <input v-model="draft.definition" :class="field" class="col-span-2" placeholder="التعريف" />
      <button
        class="col-span-2 rounded bg-mizaj-emerald px-3 py-1 text-white"
        data-testid="gloss-save"
      >
        {{ draft.id === null ? 'إضافة' : 'حفظ التعديل' }}
      </button>
    </form>
    <ul class="max-h-56 divide-y overflow-auto dark:divide-slate-700" data-testid="gloss-list">
      <li
        v-for="e in entries"
        :key="e.term + e.id"
        class="flex items-center gap-2 py-1 text-sm"
        data-testid="gloss-row"
        :data-builtin="e.builtin"
      >
        <span class="w-1/3 font-semibold">{{ e.term }}</span>
        <span class="font-editor flex-1">{{ e.diacritized }}</span>
        <span v-if="e.builtin" class="text-xs text-slate-500">مدمج</span>
        <template v-else>
          <button class="text-xs text-mizaj-emerald" @click="edit(e)">تعديل</button>
          <button class="text-xs text-red-500" data-testid="gloss-delete" @click="remove(e)">
            حذف
          </button>
        </template>
      </li>
    </ul>
  </div>
</template>
