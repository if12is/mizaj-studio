import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { announceFeature } from '@renderer/composables/useFeatureGuide'

type Req = Parameters<GeminiBridge['ask']>[0]

export interface GeminiAnswer {
  ok: boolean
  text: string
  suggestion: string | null
  truncated: boolean
  cutoff: boolean
  /** the document text changed since the last question, so the context was re-sent */
  contextRefreshed: boolean
  /** quota: seconds Google asked us to wait */
  retryAfterSec: number | null
  message: string | null
  /** error code from the main process (e.g. 'aborted' after «إيقاف») */
  code: string | null
  usage: GeminiUsageDto | null
}

export interface AskHooks {
  /** the stream id, available before the request finishes (needed for «إيقاف») */
  onStart?: (id: string) => void
  /** each visible text delta as it arrives */
  onDelta?: (delta: string) => void
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
  /** enabled AND an API key is saved */
  const ready = computed(() => !!state.value?.config.enabled && state.value.hasKey)

  async function load(): Promise<void> {
    try {
      state.value = (await api()?.getState()) ?? null
    } catch {
      state.value = null
    }
  }

  async function setConfig(patch: Parameters<GeminiBridge['setConfig']>[0]): Promise<void> {
    const wasEnabled = state.value?.config.enabled === true
    const s = await api()?.setConfig(patch)
    if (s) state.value = s
    if (s && !wasEnabled && s.config.enabled) announceFeature('gemini')
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
    busy.value = true
    try {
      const r = await api()?.saveKey(key)
      if (!r) return false
      if (!r.ok) {
        message.value = { ok: false, text: r.message }
        return false
      }
      state.value = r.state
      if (r.check.ok && r.check.models) {
        models.value = r.check.models
        modelsSource.value = 'live'
        message.value = {
          ok: true,
          text: `المفتاح صالح ✓ (${r.check.models.length} نموذجاً متاحاً)`
        }
        const cur = state.value.config.model
        if (r.check.defaultModel && (!cur || !r.check.models.some((m) => m.id === cur)))
          await setConfig({ model: r.check.defaultModel })
      } else
        message.value = {
          ok: false,
          text: `حُفظ المفتاح لكن تعذّر التحقق منه الآن: ${r.check.message ?? ''}`
        }
      return true
    } finally {
      busy.value = false
    }
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
        message.value = { ok: true, text: `المفتاح صالح ✓ (${r.models.length} نموذجاً متاحاً)` }
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

  async function sessionGet(docId: number, text: string): Promise<GeminiSessionDto | null> {
    try {
      const r = await api()?.sessionGet(docId, text)
      return r?.ok ? r.session : null
    } catch {
      return null
    }
  }

  async function sessionReset(docId: number): Promise<boolean> {
    const r = await api()?.sessionReset(docId)
    return r?.ok === true
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

  /** «إيقاف»: aborts the running request in the main process (cleanly). */
  function cancel(id: string): void {
    void api()?.cancel(id)
  }

  async function ask(req: Req, hooks: AskHooks = {}): Promise<GeminiAnswer> {
    const none: GeminiAnswer = {
      ok: false,
      text: '',
      suggestion: null,
      truncated: false,
      cutoff: false,
      contextRefreshed: false,
      retryAfterSec: null,
      message: null,
      code: null,
      usage: null
    }
    if (!api()) return { ...none, message: 'هذه الميزة متاحة في تطبيق سطح المكتب فقط.' }
    if (!(await ensureConsent()))
      return { ...none, message: 'لم يُرسل شيء: لم تُوافق على الإشعار.' }
    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const off = api()!.onChunk((m) => {
      if (m.id === id) hooks.onDelta?.(m.delta)
    })
    hooks.onStart?.(id)
    try {
      const r = await api()!.ask(req, id)
      if (!r.ok)
        return { ...none, message: r.message, code: r.code, retryAfterSec: r.retryAfterSec ?? null }
      return {
        ok: true,
        text: r.result.text,
        suggestion: r.result.suggestion,
        truncated: r.result.truncated,
        cutoff: r.result.cutoff,
        contextRefreshed: r.result.contextRefreshed,
        retryAfterSec: null,
        message: null,
        code: null,
        usage: r.result.usage ?? null
      }
    } finally {
      off()
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
    ready,
    load,
    setConfig,
    loadModels,
    saveKey,
    clearKey,
    testKey,
    sessionGet,
    sessionReset,
    ensureConsent,
    answerConsent,
    ask,
    cancel
  }
})
