import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import {
  batchStartError,
  isFinished,
  validateBatchForm,
  type BatchForm,
  type BatchSnapshot
} from '@renderer/files/batch'

export const useBatchStore = defineStore('batch', () => {
  const job = ref<BatchSnapshot | null>(null)
  const starting = ref(false)
  const error = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null

  const running = computed(() => !!job.value && !isFinished(job.value.status))

  function stopPolling(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  async function poll(id: string): Promise<void> {
    try {
      job.value = await useApi().request<BatchSnapshot>('GET', `/api/batch/${id}`, undefined, true)
    } catch {
      /* transient; try again */
    }
    if (job.value && !isFinished(job.value.status)) timer = setTimeout(() => void poll(id), 300)
  }

  async function start(form: BatchForm): Promise<void> {
    error.value = validateBatchForm(form)
    if (error.value) return
    starting.value = true
    job.value = null
    try {
      const r = await useApi().request<{ job_id: string }>('POST', '/api/batch', form, true)
      await poll(r.job_id)
    } catch (e) {
      error.value = batchStartError(e)
    } finally {
      starting.value = false
    }
  }

  async function cancel(): Promise<void> {
    const id = job.value?.id
    if (!id) return
    try {
      job.value = await useApi().request<BatchSnapshot>('POST', `/api/batch/${id}/cancel`, {}, true)
    } catch {
      notify('تعذر إلغاء المعالجة.')
    }
  }

  function reset(): void {
    stopPolling()
    job.value = null
    error.value = null
  }

  return { job, starting, error, running, start, cancel, reset, stopPolling }
})
