import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { parseEngines, type EnginesInfo } from './engines'

function devBackendOverride(): string | null {
  // Browser-only (Playwright / plain vite): ?backend=http://127.0.0.1:PORT
  try {
    return new URLSearchParams(window.location.search).get('backend')
  } catch {
    return null
  }
}

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
  /** Poll /health for the engine warm-up state while any engine is still loading. */
  async function pollHealth(): Promise<void> {
    stopHealth()
    const base = baseUrl.value
    if (!base) return
    try {
      const r = await fetch(`${base}/health`)
      engines.value = parseEngines(await r.json())
    } catch {
      return
    }
    const e = engines.value
    if (e && (e.fast === 'loading' || e.accurate === 'loading')) {
      healthTimer = setTimeout(() => void pollHealth(), 1500)
    }
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

  async function init(): Promise<void> {
    const api = window.mizajAPI
    if (!api) return
    api.onSidecarStatus(apply)
    const cfg = await api.getBackendConfig()
    apply(cfg.status)
  }

  return { status, baseUrl, isReady, engines, accurateMissing, init }
})
