<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'

interface NameEntry {
  id: number | null
  term: string
  diacritized: string
  kind: string
  builtin: boolean
}
const entries = ref<NameEntry[]>([])
const q = ref('')
const draft = ref({ id: null as number | null, term: '', diacritized: '', kind: '' })
const fileInput = ref<HTMLInputElement | null>(null)
const field = 'rounded border px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800'

let loadSeq = 0
async function load(): Promise<void> {
  const seq = ++loadSeq // only the newest request may write (a slow older search must not win)
  try {
    const list = await useApi().get<NameEntry[]>(
      `/api/names${q.value.trim() ? `?q=${encodeURIComponent(q.value.trim())}` : ''}`,
      true
    )
    if (seq === loadSeq) entries.value = list
  } catch {
    if (seq === loadSeq) entries.value = []
  }
}
onMounted(() => void load())

const reset = (): void => {
  draft.value = { id: null, term: '', diacritized: '', kind: '' }
}
async function save(): Promise<void> {
  const d = draft.value
  if (!d.term.trim()) return
  const body = {
    term: d.term.trim(),
    diacritized: d.diacritized.trim() || d.term.trim(),
    kind: d.kind.trim()
  }
  try {
    if (d.id !== null) await useApi().put(`/api/names/${d.id}`, body)
    else await useApi().post('/api/names', body)
    reset()
    await load()
  } catch {
    /* toast shown */
  }
}
const edit = (e: NameEntry): void => {
  draft.value = { id: e.id, term: e.term, diacritized: e.diacritized, kind: e.kind }
}
async function remove(e: NameEntry): Promise<void> {
  if (e.id === null) return
  await useApi().del(`/api/names/${e.id}`)
  await load()
}
async function exportAll(): Promise<void> {
  const data = await useApi().get('/api/names/export')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  )
  a.download = 'mizaj-names.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
async function importFile(ev: Event): Promise<void> {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const parsed = JSON.parse(await f.text()) as { entries?: unknown[] }
    if (!Array.isArray(parsed.entries)) throw new Error('bad')
    const r = await useApi().post<{ imported: number; updated: number }>('/api/names/import', {
      entries: parsed.entries
    })
    notify(`تم الاستيراد: ${r.imported} جديد، ${r.updated} محدّث`, { kind: 'success' })
    await load()
  } catch {
    notify('ملف الأعلام غير صالح.')
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}
</script>

<template>
  <div class="space-y-2" data-testid="names-manager">
    <div class="flex gap-2">
      <input
        v-model="q"
        :class="field"
        class="flex-1"
        placeholder="بحث في الأعلام"
        aria-label="بحث في الأعلام"
        data-testid="names-search"
        @input="load"
      />
      <button
        class="rounded border px-2 text-sm dark:border-slate-600"
        data-testid="names-export"
        @click="exportAll"
      >
        تصدير JSON
      </button>
      <button
        class="rounded border px-2 text-sm dark:border-slate-600"
        data-testid="names-import"
        @click="fileInput?.click()"
      >
        استيراد JSON
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        class="hidden"
        aria-label="ملف الأعلام"
        data-testid="names-import-file"
        @change="importFile"
      />
    </div>
    <form class="grid grid-cols-3 gap-2" @submit.prevent="save">
      <input
        v-model="draft.term"
        :class="field"
        placeholder="العلم"
        aria-label="العلم"
        data-testid="names-term"
      />
      <input
        v-model="draft.diacritized"
        :class="field"
        placeholder="الصيغة المشكولة"
        aria-label="الصيغة المشكولة"
        data-testid="names-diacritized"
      />
      <input
        v-model="draft.kind"
        :class="field"
        placeholder="النوع (شخص، مكان…)"
        aria-label="نوع العلم"
        data-testid="names-kind"
      />
      <button
        class="col-span-3 rounded bg-mizaj-emerald px-3 py-1 text-white"
        data-testid="names-save"
      >
        {{ draft.id === null ? 'إضافة علم' : 'حفظ التعديل' }}
      </button>
    </form>
    <ul class="max-h-48 divide-y overflow-auto dark:divide-slate-700" data-testid="names-list">
      <li
        v-for="e in entries"
        :key="e.term + e.id"
        class="flex items-center gap-2 py-1 text-sm"
        data-testid="names-row"
        :data-builtin="e.builtin"
      >
        <span class="w-1/4 font-semibold">{{ e.term }}</span>
        <span class="font-editor flex-1">{{ e.diacritized }}</span>
        <span class="text-xs text-slate-500">{{ e.kind }}</span>
        <span v-if="e.builtin" class="text-xs text-slate-500">مدمج</span>
        <template v-else>
          <button class="text-xs text-mizaj-emerald" @click="edit(e)">تعديل</button>
          <button class="text-xs text-red-500" data-testid="names-delete" @click="remove(e)">
            حذف
          </button>
        </template>
      </li>
    </ul>
  </div>
</template>
