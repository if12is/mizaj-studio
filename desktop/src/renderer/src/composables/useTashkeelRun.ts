import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { Compartment } from '@codemirror/state'
import { streamTashkeel } from '@renderer/api/sse'
import { notify } from '@renderer/api/toast'
import { useEditorStore } from '@renderer/stores/editor'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import { useSidecarStore } from '@renderer/stores/sidecar'
import { RunSession } from '@renderer/editor/runSession'
import { addConfidence, buildConfMarks } from '@renderer/editor/confidence'
import { quranField } from '@renderer/editor/quran'
import { useQualityStore } from '@renderer/stores/quality'
import { useProofreadStore } from '@renderer/stores/proofread'
import { recordEvent } from '@renderer/stores/history'
import { EVENT_LABELS } from '@renderer/history/logic'
import { wordsDiacritized } from '@renderer/proofread/oneStep'

export const readOnlyCompartment = new Compartment()

interface PausedRange {
  whole: boolean
  from: number
  to: number
}

/**
 * Streaming diacritization. Decision: the editor is READ-ONLY while a run is
 * in progress (chunks are mapped through the run's own earlier edits only);
 * pause / cancel / done each collapse the applied chunks into one undo step.
 */
export function useTashkeelRun(getView: () => EditorView | null, onApplied: () => void) {
  const editor = useEditorStore()
  const settings = useSettingsStore()
  const sidecar = useSidecarStore()
  const projects = useProjectsStore()
  const quality = useQualityStore()
  const proofread = useProofreadStore()
  let ctrl: AbortController | null = null
  let paused: PausedRange | null = null
  let session: RunSession | null = null
  let wantPause = false
  let doneTimer: ReturnType<typeof setTimeout> | null = null
  /** outcome of the last run, read by the one-step «تدقيق وتشكيل» summary */
  let lastCompleted = false
  let lastDoubtful = 0

  const setReadOnly = (view: EditorView, ro: boolean): void =>
    view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(ro)) })

  function commit(view: EditorView): void {
    if (!session) return
    for (const spec of session.finish(view.state)) view.dispatch(spec)
    if (session.hasChanges()) {
      const id = projects.currentDocument?.id
      if (id !== undefined) editor.diacritizedDocs = { ...editor.diacritizedDocs, [id]: true }
      onApplied()
      const marks = buildConfMarks(view.state, session.takeConfidence(), 0)
      lastDoubtful += marks.length
      if (marks.length) view.dispatch({ effects: addConfidence.of(marks) })
    }
  }

  async function execute(view: EditorView, range: PausedRange): Promise<void> {
    if (!sidecar.baseUrl) {
      notify('المحرك الخلفي غير جاهز بعد.')
      return
    }
    const from = range.whole ? 0 : range.from
    const to = range.whole ? view.state.doc.length : range.to
    const text = view.state.sliceDoc(from, to)
    if (!text.trim()) return
    const runBefore = view.state.doc.toString() // for the edit history (read-only during the run)
    const protect = quality.quranProtect
    const mine = new RunSession(view.state, from, text, {
      isProtected: (a, b) =>
        protect && (view.state.field(quranField, false) ?? []).some((s) => a < s.to && b > s.from)
    })
    session = mine
    ctrl = new AbortController()
    wantPause = false
    if (doneTimer) clearTimeout(doneTimer)
    let completed = false
    let lastYield = performance.now()
    editor.runState = 'running'
    setReadOnly(view, true)
    const body: Record<string, unknown> = {
      text,
      mode: settings.values.engine_mode,
      level: settings.values.tashkeel_level,
      confidence: quality.confidenceShow,
      confidence_threshold: quality.confidenceThreshold,
      protect_quran: quality.quranProtect
    }
    if (quality.poetryOn) body.poetry = true
    if (projects.currentDocument) body.document_id = projects.currentDocument.id
    try {
      for await (const msg of streamTashkeel({
        baseUrl: sidecar.baseUrl,
        body,
        signal: ctrl.signal
      })) {
        if (session !== mine) break
        if (msg.type === 'waiting') {
          editor.runState = 'waiting'
        } else if (msg.type === 'chunk') {
          editor.runState = 'running'
          const spec = mine.applyChunk(view.state, msg.chunk)
          if (spec) view.dispatch(spec)
          editor.progress = msg.chunk.progress
          editor.wps = msg.chunk.wps
          // keep the UI responsive (paint progress, accept Pause) during big runs
          if (performance.now() - lastYield > 30) {
            await new Promise((r) => setTimeout(r, 0))
            lastYield = performance.now()
          }
        } else if (msg.type === 'done') {
          editor.progress = 100
          editor.wps = msg.info.wps
          paused = null
          completed = true
        } else {
          notify(msg.error.messageAr)
          break
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        notify('تعذر الاتصال بالمحرك الخلفي أثناء التشكيل.')
      }
    }
    lastCompleted = completed && !wantPause
    // finalize (done / error / abort): one undo step for what was applied
    const sess = session === mine ? mine : null
    if (sess) commit(view)
    if (sess?.hasChanges()) {
      recordEvent(EVENT_LABELS.beforeTashkeel, runBefore)
      recordEvent(
        wantPause
          ? EVENT_LABELS.tashkeelPartial
          : range.whole
            ? EVENT_LABELS.tashkeelFull
            : EVENT_LABELS.tashkeelSelection
      )
    }
    setReadOnly(view, false)
    if (!sess) return
    if (wantPause) {
      paused = {
        whole: range.whole,
        from: sess.mapPos(from),
        to: sess.mapPos(to)
      }
      editor.runState = 'paused'
    } else {
      if (completed) {
        // keep the bar visible at 100% for a moment so the result is observable
        editor.runState = 'done'
        doneTimer = setTimeout(() => {
          if (editor.runState === 'done') editor.runState = 'idle'
        }, 2500)
      } else editor.runState = 'idle'
      if (editor.progress >= 100 && sess.skipped > 0) {
        notify(`تم تخطي ${sess.skipped} مقطع لأن النص تغيّر أثناء التشكيل.`, { kind: 'info' })
      }
    }
    ctrl = null
    session = null
  }

  const isBusy = (): boolean => editor.runState === 'running' || editor.runState === 'waiting'

  /**
   * Diacritize the selection, or the whole document when nothing is selected.
   * The proofreading gate runs first (setting «التدقيق قبل التشكيل»); `force` always opens the
   * review panel («تدقيق ثم تشكيل»). The gate only ever applies what the user accepted.
   */
  async function start(
    opts: { force?: boolean; skipGate?: boolean; diffBase?: string } = {}
  ): Promise<void> {
    const view = getView()
    if (!view || isBusy()) return
    if (!opts.skipGate && !(await proofread.gate(opts.force === true))) return
    if (getView() !== view || isBusy()) return // the document changed while the panel was open
    if (doneTimer) clearTimeout(doneTimer)
    const sel = view.state.selection.main
    editor.diffBase = opts.diffBase ?? view.state.doc.toString()
    editor.progress = 0
    editor.wps = 0
    paused = null
    await execute(view, { whole: sel.empty, from: sel.from, to: sel.to })
  }

  function pause(): void {
    if (!ctrl) return
    wantPause = true
    ctrl.abort()
  }

  /** Re-POST the same text; the server cache makes finished chunks instant. */
  async function resume(): Promise<void> {
    const view = getView()
    if (!view || !paused) return
    const r = paused
    paused = null
    await execute(view, r)
  }

  function cancel(): void {
    if (ctrl) {
      wantPause = false
      ctrl.abort()
    } else {
      paused = null
      editor.runState = 'idle'
    }
  }

  /** Document switch: stop without committing (the state is being replaced). */
  function reset(): void {
    wantPause = false
    if (doneTimer) clearTimeout(doneTimer)
    ctrl?.abort()
    paused = null
    session = null
    editor.runState = 'idle'
    editor.progress = 0
  }

  /** The toolbar workflow «تدقيق ثم تشكيل»: review proposals, apply the accepted, then run. */
  const proofreadThenStart = (): Promise<void> => start({ force: true })

  /**
   * «تدقيق وتشكيل» in one step: proofread (all categories, per the auto-accept policy), apply,
   * diacritize, then show ONE summary. The comparison view keeps the text from before the run.
   */
  async function proofreadAndTashkeel(): Promise<void> {
    const view = getView()
    if (!view || isBusy()) return
    const original = view.state.doc.toString()
    const step = await proofread.oneStepProofread()
    if (!step) return
    if (getView() !== view || isBusy()) return // the document changed while the panel was open
    if (!step.run) {
      editor.diffBase = original
      return
    }
    const proofed = view.state.doc.toString()
    lastCompleted = false
    lastDoubtful = 0
    await start({ skipGate: true, diffBase: original })
    if (!lastCompleted || getView() !== view) return
    proofread.summary = {
      fixed: step.fixed,
      words: wordsDiacritized(proofed, view.state.doc.toString()),
      doubtful: lastDoubtful
    }
  }

  return { start, proofreadThenStart, proofreadAndTashkeel, pause, resume, cancel, reset }
}
