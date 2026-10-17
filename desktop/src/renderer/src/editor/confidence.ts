import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view'

/** Low-confidence words (7.1.3) and review mode (7.2.1). Positions are UTF-16 document offsets. */
export interface ConfWord {
  u16_start: number
  u16_end: number
  confidence: number
  irab_confidence: number | null
}

export interface ConfMark {
  from: number
  to: number
  word: string
  confidence: number
  irab: number | null
  reviewed: boolean
}

export const addConfidence = StateEffect.define<ConfMark[]>()
export const clearConfidence = StateEffect.define<null>()
export const markReviewed = StateEffect.define<number>()

/** Build marks for server `words` whose offsets are relative to a text placed at `base`. */
export function buildConfMarks(
  state: EditorState,
  words: ConfWord[] | undefined,
  base: number
): ConfMark[] {
  const out: ConfMark[] = []
  for (const w of words ?? []) {
    const from = base + w.u16_start
    const to = base + w.u16_end
    if (to <= from || to > state.doc.length) continue
    out.push({
      from,
      to,
      word: state.doc.sliceString(from, to),
      confidence: w.confidence,
      irab: w.irab_confidence,
      reviewed: false
    })
  }
  return out
}

export const confField = StateField.define<ConfMark[]>({
  create: () => [],
  update(marks, tr) {
    if (tr.docChanged && marks.length) {
      const kept: ConfMark[] = []
      for (const m of marks) {
        const from = tr.changes.mapPos(m.from, 1)
        const to = tr.changes.mapPos(m.to, -1)
        // editing the word itself (e.g. through the inspector) resolves the doubt
        if (to > from && tr.newDoc.sliceString(from, to) === m.word) kept.push({ ...m, from, to })
      }
      marks = kept
    }
    for (const e of tr.effects) {
      if (e.is(clearConfidence)) marks = []
      else if (e.is(addConfidence)) {
        const fresh = e.value
        marks = [
          ...marks.filter((m) => !fresh.some((f) => m.from < f.to && m.to > f.from)),
          ...fresh
        ].sort((a, b) => a.from - b.from)
      } else if (e.is(markReviewed))
        marks = marks.map((m) => (m.from === e.value ? { ...m, reviewed: true } : m))
    }
    return marks
  }
})

export interface SpanLike {
  from: number
  to: number
}

const overlaps = (m: SpanLike, spans: SpanLike[]): boolean =>
  spans.some((s) => m.from < s.to && m.to > s.from)

/** Words to review: below the threshold (word or i'rab certainty), not reviewed, never Quran text. */
export function reviewCandidates(
  marks: ConfMark[],
  threshold: number,
  protectedSpans: SpanLike[] = []
): ConfMark[] {
  return marks
    .filter(
      (m) => !m.reviewed && (m.confidence < threshold || (m.irab !== null && m.irab < threshold))
    )
    .filter((m) => !overlaps(m, protectedSpans))
    .sort((a, b) => a.from - b.from)
}

export function nextCandidate(cands: ConfMark[], pos: number, dir: 1 | -1): ConfMark | null {
  if (!cands.length) return null
  if (dir === 1) return cands.find((m) => m.from > pos) ?? cands[0]
  return [...cands].reverse().find((m) => m.from < pos) ?? cands[cands.length - 1]
}

export interface ReviewStats {
  total: number
  reviewed: number
  remaining: number
}

export function reviewStats(
  marks: ConfMark[],
  threshold: number,
  protectedSpans: SpanLike[] = []
): ReviewStats {
  const flagged = marks
    .filter((m) => m.confidence < threshold || (m.irab !== null && m.irab < threshold))
    .filter((m) => !overlaps(m, protectedSpans))
  const reviewed = flagged.filter((m) => m.reviewed).length
  return { total: flagged.length, reviewed, remaining: flagged.length - reviewed }
}

/** Heat 0..1 used for the underline opacity (lower confidence = stronger). */
export const heat = (confidence: number): number => Math.min(1, Math.max(0.15, 1 - confidence))

export interface ConfConfig {
  getThreshold(): number
  getProtected(state: EditorState): SpanLike[]
  isReviewActive(): boolean
  setReviewActive(on: boolean): void
  onStats(s: ReviewStats): void
}

function candidatesOf(cfg: ConfConfig, state: EditorState): ConfMark[] {
  return reviewCandidates(state.field(confField), cfg.getThreshold(), cfg.getProtected(state))
}

/** Select the next/previous word to review. */
export function reviewStep(cfg: ConfConfig, view: EditorView, dir: 1 | -1): boolean {
  const m = nextCandidate(candidatesOf(cfg, view.state), view.state.selection.main.head, dir)
  if (!m) return false
  view.dispatch({
    selection: { anchor: m.from, head: m.to },
    effects: EditorView.scrollIntoView(m.from, { y: 'center' })
  })
  return true
}

/** Keep the current word as is: mark it reviewed and move on. */
export function reviewKeep(cfg: ConfConfig, view: EditorView): boolean {
  const sel = view.state.selection.main
  const cur = candidatesOf(cfg, view.state).find((m) => sel.from >= m.from && sel.to <= m.to)
  if (!cur) return false
  view.dispatch({ effects: markReviewed.of(cur.from) })
  reviewStep(cfg, view, 1)
  return true
}

export function confidenceExtension(cfg: ConfConfig): Extension[] {
  let last: ConfMark[] | null = null
  return [
    confField,
    EditorView.decorations.compute([confField], (state) =>
      Decoration.set(
        state.field(confField).map((m) =>
          Decoration.mark({
            class: m.reviewed ? 'cm-lowconf cm-lowconf-done' : 'cm-lowconf',
            attributes: {
              style: `--lc:${heat(m.confidence).toFixed(2)}`,
              title: `ثقة التشكيل ${Math.round(m.confidence * 100)}٪`
            }
          }).range(m.from, m.to)
        ),
        true
      )
    ),
    ViewPlugin.fromClass(
      class {
        update(u: ViewUpdate): void {
          const marks = u.state.field(confField)
          if (marks !== last) {
            last = marks
            cfg.onStats(reviewStats(marks, cfg.getThreshold(), cfg.getProtected(u.state)))
          }
        }
      }
    ),
    Prec.high(
      keymap.of([
        {
          key: 'F7',
          preventDefault: true,
          run: (v) => {
            cfg.setReviewActive(true)
            return reviewStep(cfg, v, 1)
          }
        },
        {
          key: 'Shift-F7',
          preventDefault: true,
          run: (v) => (cfg.setReviewActive(true), reviewStep(cfg, v, -1))
        },
        { key: 'Mod-Enter', preventDefault: true, run: (v) => reviewKeep(cfg, v) },
        {
          key: 'Enter',
          run: (v) => cfg.isReviewActive() && reviewKeep(cfg, v)
        },
        {
          key: 'Escape',
          run: () => {
            if (!cfg.isReviewActive()) return false
            cfg.setReviewActive(false)
            return true
          }
        }
      ])
    )
  ]
}
