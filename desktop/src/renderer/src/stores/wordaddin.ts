import { defineStore } from 'pinia'
import { ref } from 'vue'

type Bridge = WordAddinBridge
type Install = Awaited<ReturnType<Bridge['install']>>
type Test = Awaited<ReturnType<Bridge['test']>>

/**
 * State of the Word add-in settings page. The truth lives in the main process (it owns the HTTPS
 * server, the certificate and the registry entry); this store only mirrors it. Off by default.
 */
export const useWordAddinStore = defineStore('wordaddin', () => {
  const state = ref<WordAddinState | null>(null)
  const busy = ref(false)
  const steps = ref<WordAddinStep[]>([])
  const checks = ref<WordAddinCheck[]>([])
  const testRan = ref(false)
  const api = (): Bridge | undefined => window.mizajAPI?.wordAddin

  async function load(): Promise<void> {
    try {
      const s = await api()?.getState()
      if (s) state.value = s
    } catch {
      /* main process unavailable (tests / browser) */
    }
  }

  async function run<T>(fn: () => Promise<T> | undefined, then: (r: T) => void): Promise<void> {
    busy.value = true
    try {
      const r = await fn()
      if (r !== undefined) then(r)
    } finally {
      busy.value = false
    }
  }

  const setEnabled = (v: boolean): Promise<void> =>
    run(
      () => api()?.setEnabled(v),
      (s) => {
        state.value = s
        steps.value = []
        checks.value = []
      }
    )

  const apply = (r: Install): void => {
    steps.value = r.steps
    state.value = r.state
    checks.value = []
  }
  const install = (): Promise<void> => run(() => api()?.install(), apply)
  const uninstall = (): Promise<void> => run(() => api()?.uninstall(), apply)
  const test = async (): Promise<void> => {
    await run<Test>(
      () => api()?.test(),
      (r) => {
        checks.value = r.checks
        testRan.value = true
      }
    )
    await load()
  }
  const openCatalog = async (): Promise<void> => {
    await api()?.openCatalog()
  }

  return {
    state,
    busy,
    steps,
    checks,
    testRan,
    load,
    setEnabled,
    install,
    uninstall,
    test,
    openCatalog
  }
})
