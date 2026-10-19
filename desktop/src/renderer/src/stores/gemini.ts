import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

type Req = Parameters<GeminiBridge['ask']>[0]

export interface GeminiAnswer {
  ok: boolean
  text: string
  suggestion: string | null
  truncated: boolean
  cutoff: boolean
  /** quota: seconds Google asked us to wait */
  retryAfterSec: number | null
  message: string | null
}

/**
 * State of the optional Gemini assistant. Everything secret or networked lives in the main process
 * (window.mizajAPI.gemini); this store only holds non-secret status and a masked key hint.
 */
export const useGeminiStore = defineStore('gemini', () => {
  const api = (): GeminiBridge | undefined => window.mizajAPI?.gemini
  const state = ref<GeminiStateDto | null>(null)
  const models = ref<GeminiModelDto[]>([])
  const modelsSource = ref<'live' | 'fallback' | null>(null)
  const message = ref<{ ok: boolean; text: string } | null>(null)
  const busy = ref(false)
  const consentOpen = ref(false)
  let consentResolve: ((ok: boolean) => void) | null = null

  const config = computed(() => state.value?.config ?? null)
  const enabled = computed(() => config.value?.enabled === true)
  const provider = computed(() => config.value?.provider ?? 'api')
  /** enabled AND the chosen provider is usable */
  const ready = computed(() => {
    const s = state.value
    if (!s || !s.config.enabled) return false
    return s.config.provider === 'cli' ? s.config.useCli && s.cli.detected : s.hasKey
  })

  async function load(): Promise<void> {
    try {
      state.value = (await api()?.getState()) ?? null
    } catch {
      state.value = null
    }
  }

  async function setConfig(patch: Parameters<GeminiBridge['setConfig']>[0]): Promise<void> {
    const s = await api()?.setConfig(patch)
    if (s) state.value = s
  }

  async function loadModels(): Promise<void> {
    const r = await api()?.models()
    if (!r) return
    if (r.ok) {
      models.value = r.models
      modelsSource.value = r.source
      const cur = state.value?.config.model
      if (!cur || !r.models.some((m) => m.id === cur)) await setConfig({ model: r.defaultModel })
    } else message.value = { ok: false, text: r.message }
  }

  async function saveKey(key: string): Promise<boolean> {
    message.value = null
    const r = await api()?.saveKey(key)
    if (!r) return false
    if (!r.ok) {
      message.value = { ok: false, text: r.message }
      return false
    }
    state.value = r.state
    await loadModels()
    return true
  }

  async function clearKey(): Promise<void> {
    const s = await api()?.clearKey()
    if (s) state.value = s
    models.value = []
    modelsSource.value = null
    message.value = { ok: true, text: 'حُذف المفتاح من هذا الجهاز.' }
  }

  async function testKey(candidate?: string): Promise<void> {
    busy.value = true
    message.value = null
    try {
      const r = await api()?.testKey(candidate || undefined)
      if (!r) return
      if (r.ok) {
        models.value = r.models
        modelsSource.value = 'live'
        message.value = { ok: true, text: `المفتاح صالح (${r.models.length} نموذجاً متاحاً).` }
        if (state.value?.hasKey) {
          const cur = state.value.config.model
          if (!cur || !r.models.some((m) => m.id === cur))
            await setConfig({ model: r.defaultModel })
        }
      } else message.value = { ok: false, text: r.message }
    } finally {
      busy.value = false
    }
  }

  async function redetectCli(): Promise<void> {
    const cli = await api()?.detectCli()
    if (cli && state.value) state.value = { ...state.value, cli }
  }

  /** First use: show the notice (once, ever); resolves true if consent exists/was given. */
  function ensureConsent(): Promise<boolean> {
    if (state.value?.config.consentAt) return Promise.resolve(true)
    if (consentResolve) consentResolve(false)
    consentOpen.value = true
    return new Promise((res) => {
      consentResolve = res
    })
  }
  async function answerConsent(accept: boolean): Promise<void> {
    consentOpen.value = false
    if (accept) {
      const s = await api()?.acceptConsent()
      if (s) state.value = s
    }
    consentResolve?.(accept)
    consentResolve = null
  }

  async function ask(req: Req): Promise<GeminiAnswer> {
    const none: GeminiAnswer = {
      ok: false,
      text: '',
      suggestion: null,
      truncated: false,
      cutoff: false,
      retryAfterSec: null,
      message: null
    }
    if (!api()) return { ...none, message: 'هذه الميزة متاحة في تطبيق سطح المكتب فقط.' }
    if (!(await ensureConsent()))
      return { ...none, message: 'لم يُرسل شيء: لم تُوافق على الإشعار.' }
    const r = await api()!.ask(req)
    if (!r.ok) return { ...none, message: r.message, retryAfterSec: r.retryAfterSec ?? null }
    return {
      ok: true,
      text: r.result.text,
      suggestion: r.result.suggestion,
      truncated: r.result.truncated,
      cutoff: r.result.cutoff,
      retryAfterSec: null,
      message: null
    }
  }

  return {
    state,
    models,
    modelsSource,
    message,
    busy,
    consentOpen,
    config,
    enabled,
    provider,
    ready,
    load,
    setConfig,
    loadModels,
    saveKey,
    clearKey,
    testKey,
    redetectCli,
    ensureConsent,
    answerConsent,
    ask
  }
})
