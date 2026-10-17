import type { EditorView } from '@codemirror/view'
import { whenIdle } from '@renderer/lib/idle'
import { useApi } from '@renderer/api'
import { clearQuranSpans, setQuranSpans, toSpans, type QuranSpanRaw } from '@renderer/editor/quran'
import { useEditorStore } from '@renderer/stores/editor'
import { useQualityStore } from '@renderer/stores/quality'
import { rangesToCheck } from './useSpellCheck'

export const QURAN_DEBOUNCE_MS = 1200

/** Debounced Quran verse detection over the visible ranges (whole text for small documents). */
export function useQuranDetect(getView: () => EditorView | null) {
  const editor = useEditorStore()
  const quality = useQualityStore()
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelIdle: (() => void) | null = null

  async function detect(full = false): Promise<void> {
    const view = getView()
    if (!view) return
    if (editor.runState === 'running' || editor.runState === 'waiting') return
    const doc = view.state.doc
    if (doc.length === 0) return
    const ranges = rangesToCheck(
      doc.length,
      view.visibleRanges.map((r) => ({ from: r.from, to: r.to })),
      (p) => {
        const l = doc.lineAt(Math.min(p, doc.length))
        return { from: l.from, to: l.to }
      },
      full
    )
    try {
      for (const r of ranges) {
        const res = await useApi().request<{ installed: boolean; spans: QuranSpanRaw[] }>(
          'POST',
          '/api/quran/detect',
          { text: doc.sliceString(r.from, r.to), include_partial: true },
          true
        )
        const v = getView()
        if (!v || v.state.doc !== doc) return schedule()
        quality.quranInstalled = res.installed
        if (!res.installed) {
          v.dispatch({ effects: clearQuranSpans.of(null) })
          return
        }
        v.dispatch({
          effects: setQuranSpans.of({ ranges: [r], spans: toSpans(res.spans, r.from, v.state.doc) })
        })
      }
    } catch {
      /* backend busy/unavailable: try again later */
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    cancelIdle?.()
    timer = setTimeout(() => {
      // background work waits for an idle moment so typing/scrolling never competes with it
      cancelIdle = whenIdle(() => void detect(false))
    }, QURAN_DEBOUNCE_MS)
  }

  return {
    schedule,
    detectNow: () => detect(true),
    dispose: () => {
      if (timer) clearTimeout(timer)
      cancelIdle?.()
    }
  }
}
