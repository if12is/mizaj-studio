<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useProjectsStore } from '@renderer/stores/projects'
import ConfirmDialog from './ui/ConfirmDialog.vue'

const emit = defineEmits<{
  (e: 'select-document', id: number): void
  /** The open document is about to be deleted: the app must stop autosaving/showing it. */
  (e: 'closing-current'): void
}>()
const projects = useProjectsStore()
const newProject = ref<string | null>(null)
const newDocFor = ref<number | null>(null)
const newDocTitle = ref('')

type Target =
  | { kind: 'project'; id: number; label: string }
  | {
      kind: 'document'
      id: number
      projectId: number
      label: string
    }
const renaming = ref<{ kind: 'project' | 'document'; id: number; text: string } | null>(null)
const pendingDelete = ref<Target | null>(null)
/** project whose settings row («الياء آخر الكلمة») is expanded */
const settingsFor = ref<number | null>(null)
async function setYa(id: number, v: string): Promise<void> {
  try {
    await projects.setYaStyle(id, v === '' ? null : (v as 'standard' | 'egyptian'))
  } catch {
    /* error toast shown by api client */
  }
}

function startRename(kind: 'project' | 'document', id: number, current: string): void {
  renaming.value = { kind, id, text: current }
  void nextTick(() =>
    document.querySelector<HTMLInputElement>('[data-testid=rename-input]')?.select()
  )
}
async function submitRename(): Promise<void> {
  const r = renaming.value
  renaming.value = null
  const text = (r?.text ?? '').trim()
  if (!r || !text) return
  try {
    if (r.kind === 'project') await projects.renameProject(r.id, text)
    else await projects.renameDocument(r.id, text)
  } catch {
    /* error toast shown by api client */
  }
}
async function confirmDelete(): Promise<void> {
  const t = pendingDelete.value
  pendingDelete.value = null
  if (!t) return
  const cur = projects.currentDocument
  const affectsCurrent =
    !!cur && (t.kind === 'document' ? cur.id === t.id : cur.project_id === t.id)
  if (affectsCurrent) emit('closing-current')
  try {
    if (t.kind === 'project') await projects.deleteProject(t.id)
    else await projects.deleteDocument(t.id, t.projectId)
  } catch {
    /* error toast shown by api client */
  }
}
const iconBtn =
  'rounded px-1 text-xs text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-slate-100'

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
          <form
            v-if="renaming?.kind === 'project' && renaming.id === p.id"
            class="min-w-0 flex-1"
            @submit.prevent="submitRename"
          >
            <input
              v-model="renaming.text"
              class="w-full rounded border px-2 py-0.5 text-sm dark:border-slate-600 dark:bg-slate-800"
              aria-label="اسم المشروع الجديد"
              data-testid="rename-input"
              @keydown.esc.stop="renaming = null"
            />
          </form>
          <span v-else class="min-w-0 flex-1 truncate" data-testid="project-name">{{
            p.name
          }}</span>
          <span class="flex shrink-0 items-center gap-1">
            <button
              :class="iconBtn"
              title="إعادة تسمية"
              aria-label="إعادة تسمية المشروع"
              data-testid="project-rename"
              @click="startRename('project', p.id, p.name)"
            >
              ✎
            </button>
            <button
              :class="iconBtn"
              title="إعدادات المشروع"
              aria-label="إعدادات المشروع"
              data-testid="project-settings"
              @click="settingsFor = settingsFor === p.id ? null : p.id"
            >
              ⚙
            </button>
            <button
              :class="iconBtn"
              title="حذف"
              aria-label="حذف المشروع"
              data-testid="project-delete"
              @click="pendingDelete = { kind: 'project', id: p.id, label: p.name }"
            >
              🗑
            </button>
            <button
              class="text-xs text-mizaj-emerald"
              data-testid="new-document"
              @click="(newDocFor = p.id), (newDocTitle = '')"
            >
              + مستند
            </button>
          </span>
        </div>
        <div
          v-if="settingsFor === p.id"
          class="flex items-center gap-2 px-3 pb-1 text-xs"
          data-testid="project-settings-row"
        >
          <label :for="`ya-${p.id}`">الياء آخر الكلمة</label>
          <select
            :id="`ya-${p.id}`"
            class="min-w-0 flex-1 rounded border px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800"
            :value="p.ya_style ?? ''"
            data-testid="project-ya-style"
            @change="setYa(p.id, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">حسب الإعداد العام</option>
            <option value="standard">قياسي (ي)</option>
            <option value="egyptian">مصري (ى)</option>
          </select>
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
          <li
            v-for="d in projects.documents[p.id] ?? []"
            :key="d.id"
            class="flex items-center pe-3 hover:bg-slate-200 dark:hover:bg-slate-800"
            :class="{ 'bg-mizaj-emerald/20': projects.currentDocument?.id === d.id }"
          >
            <form
              v-if="renaming?.kind === 'document' && renaming.id === d.id"
              class="min-w-0 flex-1 px-6 py-0.5"
              @submit.prevent="submitRename"
            >
              <input
                v-model="renaming.text"
                class="w-full rounded border px-2 py-0.5 text-sm dark:border-slate-600 dark:bg-slate-800"
                aria-label="عنوان المستند الجديد"
                data-testid="rename-input"
                @keydown.esc.stop="renaming = null"
              />
            </form>
            <template v-else>
              <button
                class="block min-w-0 flex-1 truncate px-6 py-1 text-start text-sm"
                data-testid="document-item"
                @click="emit('select-document', d.id)"
              >
                {{ d.title }}
              </button>
              <button
                :class="iconBtn"
                title="إعادة تسمية"
                aria-label="إعادة تسمية المستند"
                data-testid="document-rename"
                @click="startRename('document', d.id, d.title)"
              >
                ✎
              </button>
              <button
                :class="iconBtn"
                title="حذف"
                aria-label="حذف المستند"
                data-testid="document-delete"
                @click="
                  pendingDelete = { kind: 'document', id: d.id, projectId: p.id, label: d.title }
                "
              >
                🗑
              </button>
            </template>
          </li>
        </ul>
      </li>
    </ul>
    <ConfirmDialog
      v-if="pendingDelete"
      :title="pendingDelete.kind === 'project' ? 'حذف المشروع' : 'حذف المستند'"
      :message="
        pendingDelete.kind === 'project'
          ? `سيُحذف المشروع «${pendingDelete.label}» بكل مستنداته نهائياً. هل تريد المتابعة؟`
          : `سيُحذف المستند «${pendingDelete.label}». هل تريد المتابعة؟`
      "
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </aside>
</template>
