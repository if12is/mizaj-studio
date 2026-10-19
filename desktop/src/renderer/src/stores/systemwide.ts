import { defineStore } from 'pinia'
import { ref } from 'vue'

type Patch = Parameters<SystemwideBridge['setConfig']>[0]

/**
 * State of «مِزَاج في أي برنامج». The truth lives in the main process (it owns the global shortcuts);
 * this store only mirrors it for the settings page. Everything is off until the user enables it.
 */
export const useSystemwideStore = defineStore('systemwide', () => {
  const state = ref<SystemwideStateDto | null>(null)
  const busy = ref(false)
  const api = (): SystemwideBridge | undefined => window.mizajAPI?.systemwide

  async function load(): Promise<void> {
    try {
      const s = await api()?.getState()
      if (s) state.value = s
    } catch {
      /* main process unavailable (tests / browser): the page shows the disabled state */
    }
  }

  async function update(patch: Patch): Promise<void> {
    busy.value = true
    try {
      const s = await api()?.setConfig(patch)
      if (s) state.value = s
    } finally {
      busy.value = false
    }
  }

  return { state, busy, load, update }
})
