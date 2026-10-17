import {
  Annotation,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  type Extension,
  type Transaction
} from '@codemirror/state'
import { Decoration, EditorView, hoverTooltip } from '@codemirror/view'

/** Quran protection (7.4.1): detected verse spans are decorated and (optionally) read-only. */
export interface QuranSpanRaw {
  start16: number
  end16: number
  sura: number
  aya: number
  aya_end?: number
  ref: string
  kind: 'verse' | 'partial'
  bracketed: boolean
  needs_confirmation: boolean
}

export interface QuranSpan {
  from: number
  to: number
  ref: string
  sura: number
  aya: number
  partial: boolean
  text: string
}

export const setQuranSpans = StateEffect.define<{
  ranges: { from: number; to: number }[]
  spans: QuranSpan[]
}>()
export const clearQuranSpans = StateEffect.define<null>()
/** Transactions carrying this annotation may touch protected text (never used for user edits). */
export const allowQuranChange = Annotation.define<boolean>()

export function toSpans(raw: QuranSpanRaw[], base: number, doc: EditorState['doc']): QuranSpan[] {
  const out: QuranSpan[] = []
  for (const r of raw) {
    const from = base + r.start16
    const to = base + r.end16
    if (to <= from || to > doc.length) continue
    out.push({
      from,
      to,
      ref: r.ref,
      sura: r.sura,
      aya: r.aya,
      partial: r.kind === 'partial',
      text: doc.sliceString(from, to)
    })
  }
  return out.sort((a, b) => a.from - b.from)
}

export const quranField = StateField.define<QuranSpan[]>({
  create: () => [],
  update(spans, tr) {
    if (tr.docChanged && spans.length) {
      const kept: QuranSpan[] = []
      for (const s of spans) {
        const from = tr.changes.mapPos(s.from, 1)
        const to = tr.changes.mapPos(s.to, -1)
        if (to > from && tr.newDoc.sliceString(from, to) === s.text) kept.push({ ...s, from, to })
      }
      spans = kept
    }
    for (const e of tr.effects) {
      if (e.is(clearQuranSpans)) spans = []
      else if (e.is(setQuranSpans)) {
        const r = e.value.ranges
        const keep = spans.filter((s) => !r.some((x) => s.from < x.to && s.to > x.from))
        spans = [...keep, ...e.value.spans].sort((a, b) => a.from - b.from)
      }
    }
    return spans
  }
})

/** Does any change of `tr` touch (strictly overlap) a protected span? Insertions at edges are fine. */
export function touchesProtected(tr: Transaction, spans: { from: number; to: number }[]): boolean {
  if (!tr.docChanged || !spans.length) return false
  let hit = false
  tr.changes.iterChangedRanges((fromA, toA) => {
    for (const s of spans) {
      const strictInside = fromA === toA && fromA > s.from && fromA < s.to // insertion inside a span
      if (strictInside || (toA > fromA && fromA < s.to && toA > s.from)) hit = true
    }
  })
  return hit
}

const protectionFlag = Facet.define<() => boolean, () => boolean>({
  combine: (v) => v[0] ?? (() => false)
})

/** Spans that must not be edited right now (empty when protection is switched off). */
export function protectedSpans(state: EditorState): QuranSpan[] {
  return state.facet(protectionFlag)() ? state.field(quranField, false) ?? [] : []
}

export interface QuranConfig {
  isProtected(): boolean
  onBlocked(ref: string): void
}

export function quranExtension(cfg: QuranConfig): Extension[] {
  return [
    quranField,
    protectionFlag.of(() => cfg.isProtected()),
    // Reject any user change that would alter protected Quran text.
    EditorState.transactionFilter.of((tr) => {
      if (!tr.docChanged || !cfg.isProtected() || tr.annotation(allowQuranChange)) return tr
      const spans = tr.startState.field(quranField, false) ?? []
      if (!touchesProtected(tr, spans)) return tr
      const first = spans.find((s) => touchesProtected(tr, [s]))
      cfg.onBlocked(first?.ref ?? '')
      return []
    }),
    EditorView.decorations.compute([quranField], (state) =>
      Decoration.set(
        state.field(quranField).map((s) =>
          Decoration.mark({
            class: s.partial ? 'cm-quran cm-quran-partial' : 'cm-quran',
            attributes: { 'data-quran-ref': s.ref }
          }).range(s.from, s.to)
        ),
        true
      )
    ),
    hoverTooltip((view, pos) => {
      const s = view.state.field(quranField).find((x) => pos >= x.from && pos <= x.to)
      if (!s) return null
      return {
        pos: s.from,
        end: s.to,
        above: true,
        create() {
          const dom = document.createElement('div')
          dom.className = 'mizaj-quran-tip'
          dom.dir = 'rtl'
          dom.dataset.testid = 'quran-tooltip'
          dom.textContent = `سورة ${s.sura}، آية ${s.aya}${s.partial ? ' (جزء من آية)' : ''} — نص محمي — لا يُعدَّل`
          return { dom }
        }
      }
    })
  ]
}

/** Edits (e.g. from apply-all / strip / find) that do not touch protected spans. */
export function dropProtected<T extends { from: number; to: number }>(
  edits: T[],
  spans: { from: number; to: number }[]
): T[] {
  return edits.filter(
    (e) =>
      !spans.some((s) =>
        e.to > e.from ? e.from < s.to && e.to > s.from : e.from > s.from && e.from < s.to
      )
  )
}
