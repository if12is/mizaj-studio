<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useApi } from '@renderer/api'
import { ApiError } from '@renderer/api/client'
import { notify } from '@renderer/api/toast'
import { useProjectsStore } from '@renderer/stores/projects'

const emit = defineEmits<{ (e: 'open', id: number, diacritize: boolean): void }>()
const projects = useProjectsStore()
const dragging = ref(false)
const card = ref<{
  name: string
  size: number
  state: 'importing' | 'ready' | 'error'
  docId?: number
  wordCount?: number
  stats?: Record<string, unknown>
} | null>(null)
let depth = 0

const visible = computed(() => dragging.value || card.value !== null)
const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')

function onEnter(e: DragEvent): void {
  if (!hasFiles(e)) return
  e.preventDefault()
  depth++
  dragging.value = true
}
function onOver(e: DragEvent): void {
  if (hasFiles(e)) e.preventDefault()
}
function onLeave(): void {
  depth = Math.max(0, depth - 1)
  if (depth === 0) dragging.value = false
}

function pathOf(file: File): string {
  const api = window.mizajAPI
  if (api?.getPathForFile) return api.getPathForFile(file)
  return (file as File & { path?: string }).path ?? ''
}

async function onDrop(e: DragEvent): Promise<void> {
  if (!hasFiles(e)) return
  e.preventDefault()
  depth = 0
  dragging.value = false
  const file = e.dataTransfer?.files[0]
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.docx')) {
    notify('يمكن إسقاط ملفات ‎.docx‎ فقط.')
    return
  }
  const path = pathOf(file)
  if (!path) {
    notify('تعذر تحديد مسار الملف.')
    return
  }
  const projectId = projects.currentProjectId ?? projects.projects[0]?.id
  if (projectId === undefined) {
    notify('أنشئ مشروعاً أولاً ثم أسقط الملف.')
    return
  }
  // instant preview: name + size, before the import round-trip
  card.value = { name: file.name, size: file.size, state: 'importing' }
  try {
    const r = await useApi().post<{
      document_id: number
      title: string
      word_count: number
      stats: Record<string, unknown>
    }>('/api/docx/import', { path, project_id: projectId })
    await projects.loadDocuments(projectId)
    card.value = {
      ...card.value,
      state: 'ready',
      docId: r.document_id,
      wordCount: r.word_count,
      stats: r.stats
    }
  } catch (err) {
    if (!(err instanceof ApiError)) notify('تعذر استيراد الملف.')
    card.value = null
  }
}

function go(diacritize: boolean): void {
  const id = card.value?.docId
  card.value = null
  if (id !== undefined) emit('open', id, diacritize)
}

onMounted(() => {
  window.addEventListener('dragenter', onEnter)
  window.addEventListener('dragover', onOver)
  window.addEventListener('dragleave', onLeave)
  window.addEventListener('drop', onDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onEnter)
  window.removeEventListener('dragover', onOver)
  window.removeEventListener('dragleave', onLeave)
  window.removeEventListener('drop', onDrop)
})
defineExpose({ onDrop })
</script>

<template>
  <div
    v-if="visible"
    class="absolute inset-0 z-40 flex items-center justify-center bg-mizaj-slate/70"
    data-testid="drop-overlay"
  >
    <div
      class="min-w-[22rem] rounded-lg border-2 border-dashed border-mizaj-emerald bg-white p-6 text-center dark:bg-slate-800"
    >
      <template v-if="!card">
        <p class="text-lg font-bold">أفلت ملف Word هنا</p>
      </template>
      <template v-else>
        <p class="font-bold" data-testid="drop-file-name">{{ card.name }}</p>
        <p class="text-sm text-slate-500" data-testid="drop-file-size">
          {{ (card.size / 1024).toFixed(1) }} ك.ب
        </p>
        <p v-if="card.state === 'importing'" class="mt-2 text-sm">جاري التحليل...</p>
        <div v-else class="mt-2 text-sm" data-testid="drop-stats">
          <p>عدد الكلمات: {{ card.wordCount }}</p>
          <ul class="mt-1">
            <li v-for="(v, k) in card.stats" :key="k">{{ k }}: {{ v }}</li>
          </ul>
          <div class="mt-3 flex justify-center gap-2">
            <button
              class="rounded bg-mizaj-emerald px-3 py-1 text-white"
              data-testid="drop-diacritize"
              @click="go(true)"
            >
              تشكيل المستند
            </button>
            <button class="rounded border px-3 py-1" data-testid="drop-open" @click="go(false)">
              فتح فقط
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
