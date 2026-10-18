import type { EditorView } from '@codemirror/view'
import { ApiError } from '@renderer/api/client'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import type { ConfConfig } from '@renderer/editor/confidence'
import type { CorrectionInfo, InspectorConfig, IrabInfo } from '@renderer/editor/inspector'
import { protectedSpans, type QuranConfig } from '@renderer/editor/quran'
import { useGeminiStore } from '@renderer/stores/gemini'
import { useQualityStore } from '@renderer/stores/quality'
import { useSettingsStore } from '@renderer/stores/settings'

/** Glue between the editor extensions (confidence, review, Quran, inspector extras) and the API. */
export function useEditorQuality(getView: () => EditorView | null) {
  const quality = useQualityStore()
  const gemini = useGeminiStore()
  const settings = useSettingsStore()
  const api = (): ReturnType<typeof useApi> => useApi()

  const confidence: ConfConfig = {
    getThreshold: () => quality.confidenceThreshold,
    getProtected: (state) => protectedSpans(state),
    isReviewActive: () => quality.review.active,
    setReviewActive: (on) => {
      quality.review.active = on
    },
    onStats: (s) => {
      quality.review = { ...quality.review, ...s }
    }
  }

  let lastBlock = 0
  const quran: QuranConfig = {
    isProtected: () => quality.quranProtect,
    onBlocked: (ref) => {
      if (Date.now() - lastBlock < 2500) return
      lastBlock = Date.now()
      notify(
        `هذا نص قرآني محمي${ref ? ` (${ref})` : ''} ولا يُعدَّل. يمكنك إيقاف الحماية من الإعدادات.`,
        {
          kind: 'info'
        }
      )
    }
  }

  const inspector: Pick<
    InspectorConfig,
    | 'recordCorrection'
    | 'fetchCorrection'
    | 'acceptCorrection'
    | 'fetchIrab'
    | 'addProperNoun'
    | 'geminiEnabled'
    | 'geminiAsk'
    | 'protectedSpans'
  > = {
    recordCorrection: async (engineForm, userForm) => {
      try {
        return await api().request<CorrectionInfo>(
          'POST',
          '/api/corrections',
          { engine_form: engineForm, user_form: userForm },
          true
        )
      } catch {
        return null
      }
    },
    fetchCorrection: async (bare) => {
      try {
        const r = await api().get<{ suggestions: CorrectionInfo[] }>(
          '/api/corrections/suggestions',
          true
        )
        return r.suggestions.find((s) => s.word === bare) ?? null
      } catch {
        return null
      }
    },
    acceptCorrection: async (id) => {
      try {
        await api().request('POST', `/api/corrections/${id}/accept`, {}, true)
        notify('أُضيفت الكلمة إلى قاموسك.', { kind: 'success' })
      } catch (e) {
        if (e instanceof ApiError) notify(e.messageAr)
      }
    },
    fetchIrab: (word, context, index) =>
      api().get<IrabInfo>(
        `/api/irab?word=${encodeURIComponent(word)}&context=${encodeURIComponent(context)}&index=${index}&mode=${settings.values.engine_mode}`,
        true
      ),
    addProperNoun: async (bare, form) => {
      try {
        await api().request(
          'POST',
          '/api/names',
          { term: bare, diacritized: form, kind: 'علم' },
          true
        )
        notify('أُضيف إلى قائمة الأعلام.', { kind: 'success' })
      } catch (e) {
        if (e instanceof ApiError) notify(e.messageAr)
      }
    },
    geminiEnabled: () => gemini.ready,
    geminiAsk: async (question, word, sentence) => {
      const r = await gemini.ask({ kind: 'word', question, word, sentence })
      return { ok: r.ok, text: r.text, suggestion: r.suggestion, message: r.message }
    },
    protectedSpans: (state) => protectedSpans(state)
  }

  void getView
  return { confidence, quran, inspector }
}
