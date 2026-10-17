<script setup lang="ts">
import { ref } from 'vue'
import { useProjectsStore } from '@renderer/stores/projects'

const emit = defineEmits<{ (e: 'select-document', id: number): void }>()
const projects = useProjectsStore()
const newProject = ref<string | null>(null)
const newDocFor = ref<number | null>(null)
const newDocTitle = ref('')

async function submitProject(): Promise<void> {
  const name = (newProject.value ?? '').trim()
  newProject.value = null
  if (name) await projects.createProject(name)
}
async function submitDoc(): Promise<void> {
  const pid = newDocFor.value
  const title = newDocTitle.value.trim()
  newDocFor.value = null
  newDocTitle.value = ''
  if (pid === null || !title) return
  const d = await projects.createDocument(pid, title)
  emit('select-document', d.id)
}
</script>

<template>
  <aside
    class="flex w-64 shrink-0 flex-col border-l border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60"
    aria-label="المشاريع والمستندات"
    data-testid="sidebar"
  >
    <div class="flex items-center justify-between px-3 py-2">
      <h2 class="text-sm font-semibold">المشاريع</h2>
      <button
        class="rounded bg-mizaj-emerald px-2 py-0.5 text-xs text-white"
        data-testid="new-project"
        @click="newProject = ''"
      >
        + مشروع
      </button>
    </div>
    <form v-if="newProject !== null" class="px-3 pb-2" @submit.prevent="submitProject">
      <input
        v-model="newProject"
        class="w-full rounded border px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800"
        placeholder="اسم المشروع"
        data-testid="new-project-input"
        autofocus
      />
    </form>
    <ul class="min-h-0 flex-1 overflow-auto" data-testid="project-list">
      <li v-for="p in projects.projects" :key="p.id" data-testid="project-item">
        <div class="flex items-center justify-between px-3 py-1 text-sm font-semibold">
          <span>{{ p.name }}</span>
          <button
            class="text-xs text-mizaj-emerald"
            data-testid="new-document"
            @click="(newDocFor = p.id), (newDocTitle = '')"
          >
            + مستند
          </button>
        </div>
        <form v-if="newDocFor === p.id" class="px-3 pb-1" @submit.prevent="submitDoc">
          <input
            v-model="newDocTitle"
            class="w-full rounded border px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800"
            placeholder="عنوان المستند"
            data-testid="new-document-input"
          />
        </form>
        <ul>
          <li v-for="d in projects.documents[p.id] ?? []" :key="d.id">
            <button
              class="block w-full truncate px-6 py-1 text-start text-sm hover:bg-slate-200 dark:hover:bg-slate-800"
              :class="{ 'bg-mizaj-emerald/20': projects.currentDocument?.id === d.id }"
              data-testid="document-item"
              @click="emit('select-document', d.id)"
            >
              {{ d.title }}
            </button>
          </li>
        </ul>
      </li>
    </ul>
  </aside>
</template>
