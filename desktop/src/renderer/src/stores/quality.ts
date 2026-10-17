import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '@renderer/api'
import { useProjectsStore } from './projects'
import { useSettingsStore } from './settings'

export interface ToolsInfo {
  ollama?: { detected: boolean; models?: string[]; url?: string }
  languagetool?: { detected: boolean; arabic?: boolean; url?: string }
}

export interface ReadabilityResult {
  metrics: {
    words: number
    sentences: number
    avg_sentence_words: number
    avg_word_length: number
    osman: number | null
    level: string | null
    paragraphs: number
  }
  long_sentences: { start16: number; end16: number; words: number }[]
  passive?: { count: number; per_100_words: number }
  repeated_words?: unknown[]
  long_paragraphs?: { start16?: number; end16?: number; words?: number }[]
}

/** OSMAN: higher = easier. Plain-language band (an indicator, not a verdict). */
export function osmanBand(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'غير متاح'
  if (score >= 80) return 'سهل'
  if (score >= 60) return 'متوسط'
  if (score >= 40) return 'صعب نسبياً'
  return 'صعب'
}

/** State shared by the quality features (confidence, review, Quran, poetry, tools). */
export const useQualityStore = defineStore('quality', () => {
  const settings = useSettingsStore()
  const projects = useProjectsStore()

  const confidenceShow = computed(() => settings.values.confidence_show !== 'false')
  const confidenceThreshold = computed(() => {
    const v = parseFloat(settings.values.confidence_threshold)
    return Number.isFinite(v) ? Math.min(1, Math.max(0.05, v)) : 0.75
  })
  const quranProtect = computed(() => settings.values.quran_protect !== 'false')

  const tools = ref<ToolsInfo | null>(null)
  async function loadTools(): Promise<void> {
    try {
      tools.value = await useApi().get<ToolsInfo>('/api/tools', true)
    } catch {
      tools.value = null
    }
  }
  /** optional online/local tools: only when the switch is ON *and* the tool was detected */
  const ollamaOn = computed(
    () => settings.values.online_ollama === 'true' && !!tools.value?.ollama?.detected
  )
  const ltOn = computed(
    () => settings.values.online_languagetool === 'true' && !!tools.value?.languagetool?.detected
  )
  const ollamaModel = computed(
    () => settings.values.ollama_model || tools.value?.ollama?.models?.[0] || ''
  )

  const review = ref({ active: false, total: 0, reviewed: 0, remaining: 0 })

  const quranInstalled = ref<boolean | null>(null)
  const quranHintDismissed = computed(() => settings.values.quran_hint_dismissed === 'true')
  const settingsRequest = ref<string | null>(null)
  /** UI-B listens (settingsRequest ref or the DOM event) to open the settings dialog at a section. */
  function openSettings(section: string): void {
    settingsRequest.value = section
    window.dispatchEvent(new CustomEvent('mizaj:open-settings', { detail: { section } }))
  }

  const poetryKey = computed(() =>
    projects.currentDocument ? `poetry_mode:${projects.currentDocument.id}` : null
  )
  const poetryOn = computed(() => !!poetryKey.value && settings.values[poetryKey.value] === 'true')
  async function setPoetry(on: boolean): Promise<void> {
    if (poetryKey.value) await settings.update({ [poetryKey.value]: String(on) })
  }

  const readability = ref<ReadabilityResult | null>(null)
  const normalizeOpen = ref(false)

  return {
    confidenceShow,
    confidenceThreshold,
    quranProtect,
    tools,
    loadTools,
    ollamaOn,
    ltOn,
    ollamaModel,
    review,
    quranInstalled,
    quranHintDismissed,
    settingsRequest,
    openSettings,
    poetryOn,
    setPoetry,
    readability,
    normalizeOpen
  }
})
