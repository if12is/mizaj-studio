import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import {
  jobActive,
  onlineErrorText,
  type OnlineKey,
  type OnlineStatus,
  type Resource,
  type ResourceJob,
  type ToolsStatus
} from '@renderer/online/helpers'
import { pickOpenPath } from '@renderer/lib/native'
import { useSettingsStore } from './settings'

export const useOnlineStore = defineStore('online', () => {
  const status = ref<OnlineStatus | null>(null)
  const resources = ref<Resource[]>([])
  const tools = ref<ToolsStatus | null>(null)
  const toolsLoading = ref(false)
  const message = ref<{ ok: boolean; text: string } | null>(null)
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  async function loadStatus(): Promise<void> {
    try {
      status.value = await useApi().get<OnlineStatus>('/api/online/status', true)
    } catch {
      status.value = null
    }
  }

  async function setSwitch(key: OnlineKey, on: boolean): Promise<void> {
    await useSettingsStore().update({ [key]: String(on) })
    await Promise.all([loadStatus(), loadResources()])
  }

  async function loadResources(): Promise<void> {
    try {
      const r = await useApi().get<{ resources: Resource[] }>('/api/resources', true)
      resources.value = r.resources
      for (const res of r.resources) if (jobActive(res.job)) watchJob(res.id, res.job!.id)
    } catch {
      resources.value = []
    }
  }

  async function refreshTools(): Promise<void> {
    toolsLoading.value = true
    try {
      tools.value = await useApi().get<ToolsStatus>('/api/tools', true)
    } catch {
      tools.value = null
    } finally {
      toolsLoading.value = false
    }
  }

  function patchJob(rid: string, job: ResourceJob): void {
    resources.value = resources.value.map((r) => (r.id === rid ? { ...r, job } : r))
  }

  function watchJob(rid: string, jobId: string): void {
    if (timers.has(rid)) return
    const tick = async (): Promise<void> => {
      timers.delete(rid)
      try {
        const j = await useApi().get<ResourceJob>(`/api/resources/jobs/${jobId}`, true)
        patchJob(rid, j)
        if (jobActive(j))
          timers.set(
            rid,
            setTimeout(() => void tick(), 500)
          )
        else {
          await Promise.all([loadResources(), loadStatus()])
        }
      } catch {
        /* job vanished: refresh the list */
        void loadResources()
      }
    }
    timers.set(
      rid,
      setTimeout(() => void tick(), 300)
    )
  }

  async function download(rid: string, acceptLicense: boolean): Promise<void> {
    message.value = null
    if (!acceptLicense) {
      message.value = { ok: false, text: 'يجب قبول الترخيص قبل التنزيل.' }
      return
    }
    try {
      const r = await useApi().request<{ job_id: string }>(
        'POST',
        `/api/resources/${rid}/download`,
        { accept_license: true },
        true
      )
      patchJob(rid, { id: r.job_id, status: 'queued', bytes_done: 0, bytes_total: null })
      watchJob(rid, r.job_id)
      await loadStatus()
    } catch (e) {
      message.value = { ok: false, text: onlineErrorText(e) }
    }
  }

  async function cancel(rid: string, jobId: string): Promise<void> {
    try {
      patchJob(
        rid,
        await useApi().request<ResourceJob>('POST', `/api/resources/jobs/${jobId}/cancel`, {}, true)
      )
    } catch {
      notify('تعذر إلغاء التنزيل.')
    }
  }

  async function importFile(rid: string, acceptLicense: boolean): Promise<void> {
    message.value = null
    if (!acceptLicense) {
      message.value = { ok: false, text: 'يجب قبول الترخيص قبل الاستيراد.' }
      return
    }
    const path = await pickOpenPath([], 'Resource')
    if (!path) return
    try {
      await useApi().request(
        'POST',
        `/api/resources/${rid}/import`,
        { path, accept_license: true },
        true
      )
      message.value = { ok: true, text: 'تم استيراد الملف وتسجيل ترخيصه.' }
      await loadResources()
    } catch (e) {
      message.value = { ok: false, text: onlineErrorText(e) }
    }
  }

  function dispose(): void {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }

  return {
    status,
    resources,
    tools,
    toolsLoading,
    message,
    loadStatus,
    setSwitch,
    loadResources,
    refreshTools,
    download,
    cancel,
    importFile,
    dispose
  }
})
