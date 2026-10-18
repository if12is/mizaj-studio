import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import type { DictEntry } from '@renderer/api/client'

export interface DictExport {
  version: number
  entries: { word_or_phrase: string; diacritized_form: string }[]
}

export const useDictionaryStore = defineStore('dictionary', () => {
  const entries = ref<DictEntry[]>([])
  const query = ref('')

  let loadSeq = 0
  async function load(): Promise<void> {
    const seq = ++loadSeq // only the newest request may write (a slow older search must not win)
    const q = query.value.trim()
    const list = await useApi().get<DictEntry[]>(
      `/api/dictionary${q ? `?q=${encodeURIComponent(q)}` : ''}`
    )
    if (seq === loadSeq) entries.value = list
  }
  async function add(word: string, form: string): Promise<void> {
    await useApi().post('/api/dictionary', { word_or_phrase: word, diacritized_form: form })
    await load()
  }
  async function update(id: number, form: string): Promise<void> {
    await useApi().put(`/api/dictionary/${id}`, { diacritized_form: form })
    await load()
  }
  async function remove(id: number): Promise<void> {
    await useApi().del(`/api/dictionary/${id}`)
    await load()
  }
  async function importEntries(
    data: DictExport['entries']
  ): Promise<{ imported: number; updated: number; rejected: number }> {
    const r = await useApi().post<{ imported: number; updated: number; rejected: number }>(
      '/api/dictionary/import',
      {
        entries: data
      }
    )
    await load()
    return r
  }
  function exportAll(): Promise<DictExport> {
    return useApi().get<DictExport>('/api/dictionary/export')
  }

  return { entries, query, load, add, update, remove, importEntries, exportAll }
})
