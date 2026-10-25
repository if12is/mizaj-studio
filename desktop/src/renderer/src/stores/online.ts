import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import {
  formatBytes,
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
import { announceFeature } from '@renderer/composables/useFeatureGuide'
import { featureOf } from '@renderer/features/registry'

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
    if (on && key === 'online_languagetool') announceFeature('languagetool')
    await Promise.all([loadStatus(), loadResources()])
  }

  const PIPER_IDS = ['piper-engine-win', 'piper-voice-ar-jo-kareem-medium']
  /** «تم التفعيل … تجده الآن في»: Piper read-aloud only counts once engine AND voice are installed. */
  function announceResource(rid: string): void {
    const f = featureOf(rid)
    if (!f) return
    if (f === 'readAloud') {
      const ready = PIPER_IDS.every((id) => {
        const x = resources.value.find((r) => r.id === id)
        return x?.installed && x.enabled !== false
      })
      if (!ready) return
    }
    announceFeature(f)
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
      const prev = tools.value
      tools.value = await useApi().get<ToolsStatus>('/api/tools', true)
      // OCR became available while the app was running (the user just installed Tesseract)
      if (prev && !prev.tesseract.detected && tools.value.tesseract.detected) announceFeature('ocr')
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
          // the backend auto-enables local/private resources; online ones stay opt-in
          if (j.status === 'done' && resources.value.find((r) => r.id === rid)?.enabled)
            announceResource(rid)
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
      const r = await useApi().request<{ job_id: string | null; already_installed?: boolean }>(
        'POST',
        `/api/resources/${rid}/download`,
        { accept_license: true },
        true
      )
      if (r.already_installed || !r.job_id) {
        message.value = { ok: true, text: 'مثبّت بالفعل.' }
        await loadResources()
        return
      }
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

  /** «تفعيل» / «إيقاف» for an installed resource. */
  async function setEnabled(rid: string, on: boolean): Promise<void> {
    message.value = null
    try {
      await useApi().request('POST', `/api/resources/${rid}/enabled`, { enabled: on }, true)
      await loadResources()
      if (on) announceResource(rid)
    } catch (e) {
      message.value = { ok: false, text: onlineErrorText(e) }
    }
  }

  /** «إلغاء التثبيت»: deletes the files; the message says how much space was freed. */
  async function uninstall(rid: string): Promise<void> {
    message.value = null
    try {
      const r = await useApi().request<{ freed_bytes: number }>(
        'DELETE',
        `/api/resources/${rid}`,
        undefined,
        true
      )
      message.value = { ok: true, text: `تم إلغاء التثبيت وتحرير ${formatBytes(r.freed_bytes)}.` }
      await loadResources()
    } catch (e) {
      message.value = { ok: false, text: onlineErrorText(e) }
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
      announceResource(rid)
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
    setEnabled,
    uninstall,
    importFile,
    dispose
  }
})
