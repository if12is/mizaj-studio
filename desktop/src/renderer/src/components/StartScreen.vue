<script setup lang="ts">
/**
 * Start screen: shown over the empty editor while no document is open. Quick actions and
 * «آخر الملفات» (title, project, relative time, snippet). Opening an entry continues where the
 * user stopped (cursor + scroll are restored per document by the editor); «إزالة» only removes
 * the entry from this list, never the document.
 */
import { computed, onMounted, ref } from 'vue'
import { ApiError, type DocumentFull } from '@renderer/api/client'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import {
  recentFiles,
  removeRecentFile,
  renameRecentFile,
  setRecentSnippet
} from '@renderer/lib/recentFiles'
import { relativeTimeAr } from '@renderer/lib/relativeTime'
import { useFileStore } from '@renderer/stores/fileio'
import { useProjectsStore } from '@renderer/stores/projects'
import { useExtrasStore } from '@renderer/stores/extras'
import BrandMark from './ui/BrandMark.vue'
import AppIcon from './ui/AppIcon.vue'

const props = defineProps<{ openDocument: (id: number) => void | Promise<void> }>()
const projects = useProjectsStore()
const files = useFileStore()
const extras = useExtrasStore()
const busy = ref(false)
const SHOWN = 8

const projectName = (id: number): string => projects.projects.find((p) => p.id === id)?.name ?? ''
const entries = computed(() => recentFiles.value.slice(0, SHOWN))
const now = ref(Date.now())

const flat = (t: string): string => t.replace(/\s+/g, ' ').trim().slice(0, 110)

/** Refresh each entry from the document itself: gone documents leave the list, titles and snippets update. */
onMounted(() => {
  now.value = Date.now()
  for (const f of entries.value) {
    useApi()
      .get<DocumentFull>(`/api/documents/${f.documentId}`, true)
      .then((d) => {
        renameRecentFile(d.id, d.title)
        setRecentSnippet(d.id, flat(d.raw_content))
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) removeRecentFile(f.documentId)
      })
  }
})

async function newDocument(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    let pid = projects.currentProjectId ?? projects.projects[0]?.id
    if (pid === undefined) pid = (await projects.createProject('مستنداتي')).id
    const d = await projects.createDocument(pid, 'مستند جديد')
    await props.openDocument(d.id)
  } catch {
    notify('تعذر إنشاء المستند.')
  } finally {
    busy.value = false
  }
}

const openGuide = (): void => void window.mizajAPI?.openGuide('quick')

const btn =
  'flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm hover:border-mizaj-emerald hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mizaj-emerald dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700'
</script>

<template>
  <div
    class="pointer-events-none absolute inset-0 z-[5] overflow-auto bg-white/95 dark:bg-mizaj-slate/95"
    data-testid="start-screen"
  >
    <div class="pointer-events-auto mx-auto w-full max-w-2xl px-6 pb-10 pt-16 text-center">
      <BrandMark :size="88" breathe />
      <h2 class="mt-3 text-2xl font-bold text-slate-900 dark:text-slate-50">أهلاً بك في مِزَاج</h2>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
        ابدأ بمستند جديد أو استورد ملف Word، أو تابع من حيث توقفت.
      </p>

      <div class="mt-5 flex flex-wrap justify-center gap-3" role="group" aria-label="إجراءات سريعة">
        <button :class="btn" :disabled="busy" data-testid="start-new" @click="newDocument">
          <AppIcon name="sample" :size="16" class="text-mizaj-emerald" />مستند جديد
        </button>
        <button :class="btn" data-testid="start-import" @click="files.importFile()">
          <AppIcon name="import" :size="16" class="text-mizaj-emerald" />استيراد ملف Word
        </button>
        <button :class="btn" data-testid="start-guide" @click="openGuide">
          <AppIcon name="help" :size="16" class="text-mizaj-emerald" />فتح الدليل
        </button>
        <button :class="btn" data-testid="start-tour" @click="extras.tourActive = true">
          <AppIcon name="info" :size="16" class="text-mizaj-emerald" />جولة تعريفية
        </button>
      </div>

      <section class="mt-8 text-start" aria-labelledby="start-recent-title">
        <h3
          id="start-recent-title"
          class="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200"
        >
          آخر الملفات
        </h3>
        <p
          v-if="!entries.length"
          class="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-600 dark:border-slate-600 dark:text-slate-300"
          data-testid="start-recent-empty"
        >
          لا توجد ملفات حديثة بعد. ستظهر هنا المستندات التي تفتحها.
        </p>
        <ul v-else class="space-y-2" data-testid="start-recent">
          <li
            v-for="f in entries"
            :key="f.documentId"
            class="group relative rounded-lg border border-slate-200 bg-white hover:border-mizaj-emerald dark:border-slate-700 dark:bg-slate-800"
            data-testid="start-recent-item"
            :data-document="f.documentId"
          >
            <button
              class="block w-full rounded-lg px-4 py-2.5 pe-12 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-mizaj-emerald"
              data-testid="start-recent-open"
              @click="props.openDocument(f.documentId)"
            >
              <span class="flex items-baseline justify-between gap-3">
                <span
                  class="min-w-0 truncate font-semibold text-slate-900 dark:text-slate-50"
                  data-testid="start-recent-title"
                  >{{ f.title }}</span
                >
                <span
                  class="shrink-0 text-xs text-slate-600 dark:text-slate-300"
                  data-testid="start-recent-time"
                  >{{ relativeTimeAr(f.openedAt, now) }}</span
                >
              </span>
              <span
                v-if="projectName(f.projectId)"
                class="block truncate text-xs text-emerald-800 dark:text-emerald-300"
                data-testid="start-recent-project"
                >{{ projectName(f.projectId) }}</span
              >
              <span
                v-if="f.snippet"
                class="mt-0.5 block truncate font-editor text-sm text-slate-600 dark:text-slate-300"
                data-testid="start-recent-snippet"
                >{{ f.snippet }}</span
              >
            </button>
            <button
              class="absolute end-2 top-2 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mizaj-emerald dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-red-300"
              :aria-label="`إزالة ${f.title} من القائمة`"
              title="إزالة من القائمة (المستند نفسه لا يُحذف)"
              data-testid="start-recent-remove"
              @click="removeRecentFile(f.documentId)"
            >
              <AppIcon name="close" :size="14" />
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
