import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { parseEngines, type EnginesInfo } from './engines'
import { setApiToken, setConfigLoader, withToken } from '@renderer/api/token'

function devBackendOverride(): string | null {
  // Browser-only (Playwright / plain vite): ?backend=http://127.0.0.1:PORT
  try {
    return new URLSearchParams(window.location.search).get('backend')
  } catch {
    return null
  }
}

const HEALTH_MIN_MS = 1500
const HEALTH_MAX_MS = 5000

export const useSidecarStore = defineStore('sidecar', () => {
  const status = ref<SidecarStatus>({ state: 'starting', port: null, retry: 0 })
  const override = devBackendOverride()
  const baseUrl = ref<string | null>(override)
  if (override) status.value = { state: 'ready', port: null, retry: 0 }
  if (override) queueMicrotask(() => void pollHealth())
  const isReady = computed(() => status.value.state === 'ready' && !!baseUrl.value)

  const engines = ref<EnginesInfo | null>(null)
  const accurateMissing = computed(() => engines.value?.accurate === 'missing')
  let healthTimer: ReturnType<typeof setTimeout> | null = null

  function stopHealth(): void {
    if (healthTimer) clearTimeout(healthTimer)
    healthTimer = null
  }
  let healthDelay = HEALTH_MIN_MS
  /** Poll /health while an engine is 'loading': backoff 1.5 s -> 5 s, paused while the window is hidden. */
  async function pollHealth(reset = true): Promise<void> {
    stopHealth()
    if (reset) healthDelay = HEALTH_MIN_MS
    const base = baseUrl.value
    if (!base) return
    try {
      const r = await fetch(`${base}/health`, { headers: withToken(undefined) })
      engines.value = parseEngines(await r.json())
    } catch {
      return
    }
    const e = engines.value
    if (e && (e.fast === 'loading' || e.accurate === 'loading')) scheduleHealth()
  }
  function scheduleHealth(): void {
    healthTimer = setTimeout(() => {
      healthTimer = null
      if (document.visibilityState === 'hidden') return // resumed by visibilitychange
      void pollHealth(false)
    }, healthDelay)
    healthDelay = Math.min(HEALTH_MAX_MS, Math.round(healthDelay * 1.5))
  }
  try {
    document.addEventListener('visibilitychange', () => {
      const e = engines.value
      const loading = !!e && (e.fast === 'loading' || e.accurate === 'loading')
      if (document.visibilityState === 'visible' && loading && !healthTimer && baseUrl.value)
        void pollHealth()
    })
  } catch {
    /* no document (tests) */
  }

  function apply(s: SidecarStatus): void {
    status.value = s
    if (!override)
      baseUrl.value = s.state === 'ready' && s.port ? `http://127.0.0.1:${s.port}` : null
    if (baseUrl.value && s.state === 'ready') void pollHealth()
    else {
      stopHealth()
      engines.value = null
    }
  }

  /** Token + base URL from main. Started with the store so no request can race it (also after a reload). */
  async function loadConfig(): Promise<void> {
    const api = window.mizajAPI
    if (!api) return
    const cfg = await api.getBackendConfig()
    setApiToken(cfg.token)
    apply(cfg.status)
  }
  const configReady = window.mizajAPI ? setConfigLoader(loadConfig) : Promise.resolve()

  async function init(): Promise<void> {
    const api = window.mizajAPI
    if (!api) return
    api.onSidecarStatus(apply)
    await configReady
  }

  return { status, baseUrl, isReady, engines, accurateMissing, init }
})
