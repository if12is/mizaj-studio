<script setup lang="ts">
import MotionGroup from '@renderer/components/ui/MotionGroup.vue'
import { onMounted, ref } from 'vue'
import { useDictionaryStore, type DictExport } from '@renderer/stores/dictionary'
import { notify } from '@renderer/api/toast'

const dict = useDictionaryStore()
const word = ref('')
const form = ref('')
const editingId = ref<number | null>(null)
const editForm = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

onMounted(() => void dict.load().catch(() => {}))

async function add(): Promise<void> {
  if (!word.value.trim() || !form.value.trim()) return
  try {
    await dict.add(word.value.trim(), form.value.trim())
    word.value = ''
    form.value = ''
  } catch {
    /* error toast already shown */
  }
}
async function saveEdit(id: number): Promise<void> {
  try {
    await dict.update(id, editForm.value.trim())
    editingId.value = null
  } catch {
    /* toast */
  }
}
async function doExport(): Promise<void> {
  const data = await dict.exportAll()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'mizaj-dictionary.json'
  a.click()
  URL.revokeObjectURL(a.href)
}
async function doImport(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text()) as Partial<DictExport> | DictExport['entries']
    const entries = Array.isArray(parsed) ? parsed : parsed.entries
    if (!Array.isArray(entries)) throw new Error('bad format')
    const r = await dict.importEntries(entries)
    notify(`تم الاستيراد: ${r.imported} جديد، ${r.updated} محدّث`, { kind: 'success' })
  } catch {
    notify('ملف القاموس غير صالح.')
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}
</script>

<template>
  <div class="space-y-3" data-testid="dictionary-panel">
    <div class="flex gap-2">
      <input
        v-model="dict.query"
        class="flex-1 rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
        aria-label="بحث..."
        placeholder="بحث..."
        data-testid="dict-search"
        @input="dict.load()"
      />
      <button class="rounded border px-2 text-sm" data-testid="dict-export" @click="doExport">
        تصدير JSON
      </button>
      <button
        class="rounded border px-2 text-sm"
        data-testid="dict-import"
        @click="fileInput?.click()"
      >
        استيراد JSON
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        class="hidden"
        data-testid="dict-import-file"
        @change="doImport"
      />
    </div>
    <form class="flex gap-2" @submit.prevent="add">
      <input
        v-model="word"
        class="flex-1 rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
        aria-label="الكلمة"
        placeholder="الكلمة"
        data-testid="dict-new-word"
      />
      <input
        v-model="form"
        class="flex-1 rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
        aria-label="الصيغة المشكولة"
        placeholder="الصيغة المشكولة"
        data-testid="dict-new-form"
      />
      <button class="rounded bg-mizaj-emerald px-3 text-white" data-testid="dict-add">إضافة</button>
    </form>
    <MotionGroup
      tag="ul"
      name="m-list"
      class="relative max-h-64 divide-y overflow-auto dark:divide-slate-700"
      data-testid="dict-list"
    >
      <li
        v-for="e in dict.entries"
        :key="e.id"
        class="flex items-center gap-2 py-1"
        data-testid="dict-row"
      >
        <span class="w-1/3" data-testid="dict-row-word">{{ e.word_or_phrase }}</span>
        <input
          v-if="editingId === e.id"
          v-model="editForm"
          class="flex-1 rounded border px-2 dark:border-slate-600 dark:bg-slate-800"
          data-testid="dict-edit-input"
          @keydown.enter="saveEdit(e.id)"
        />
        <span v-else class="flex-1" data-testid="dict-row-form">{{ e.diacritized_form }}</span>
        <button
          v-if="editingId === e.id"
          class="text-xs text-mizaj-emerald"
          data-testid="dict-save"
          @click="saveEdit(e.id)"
        >
          حفظ
        </button>
        <button
          v-else
          class="text-xs text-mizaj-emerald"
          data-testid="dict-edit"
          @click="(editingId = e.id), (editForm = e.diacritized_form)"
        >
          تعديل
        </button>
        <button class="text-xs text-red-500" data-testid="dict-delete" @click="dict.remove(e.id)">
          حذف
        </button>
      </li>
      <li v-if="!dict.entries.length" class="py-2 text-sm text-slate-500" data-testid="dict-empty">
        لا توجد كلمات.
      </li>
    </MotionGroup>
  </div>
</template>
