import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

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
  const isReady = computed(() => status.value.state === 'ready' && !!baseUrl.value)

  function apply(s: SidecarStatus): void {
    status.value = s
    if (override) return
    baseUrl.value = s.state === 'ready' && s.port ? `http://127.0.0.1:${s.port}` : null
  }

  async function init(): Promise<void> {
    const api = window.mizajAPI
    if (!api) return
    api.onSidecarStatus(apply)
    const cfg = await api.getBackendConfig()
    apply(cfg.status)
  }

  return { status, baseUrl, isReady, init }
})
