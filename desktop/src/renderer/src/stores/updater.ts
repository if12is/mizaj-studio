import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useUpdaterStore = defineStore('updater', () => {
  const status = ref<UpdaterStatus>({ state: 'idle' })
  /** the banner is dismissable for 'available'; reappears on state change */
  const dismissed = ref(false)

  async function init(): Promise<void> {
    const api = window.mizajAPI
    if (!api) return
    api.onUpdaterStatus((s) => {
      if (s.state !== status.value.state) dismissed.value = false
      status.value = s
    })
    status.value = await api.getUpdaterStatus()
  }
  async function check(): Promise<void> {
    const api = window.mizajAPI
    if (!api) {
      status.value = { state: 'idle', code: 'not-packaged' }
      return
    }
    dismissed.value = false
    status.value = await api.checkForUpdates()
  }
  const download = (): Promise<void> | undefined => window.mizajAPI?.downloadUpdate()
  const install = (): Promise<void> | undefined => window.mizajAPI?.installUpdate()

  return { status, dismissed, init, check, download, install }
})
