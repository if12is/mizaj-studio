import { Annotation, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  type EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { prefersReducedMotion } from '@renderer/lib/idle'

/**
 * Fade-in of freshly applied diacritics (8.5.3). Chunks of a tashkeel run carry `freshChunk`;
 * the changed range is remembered for a moment and, for the VISIBLE part only, every word that
 * contains a mark gets the `cm-fresh` class (pure CSS opacity animation, see motion.css).
 * Whole words (never lone marks) are wrapped so Arabic shaping and COLR palettes are untouched,
 * and the class is removed again ~0.7 s after the last chunk so the DOM returns to normal.
 */
export const freshChunk = Annotation.define<boolean>()
const clearFresh = StateEffect.define<null>()

interface Word {
  from: number
  to: number
}
/** Words animating at any moment are capped: DOM churn must not grow with document size. */
const MAX_WORDS = 400
const HOLD_MS = 700
const MARKS = /[\u064B-\u0652\u0670]/
const deco = Decoration.mark({ class: 'cm-fresh' })

/** Words (with marks) of the freshly changed ranges, mapped through later edits. Cost per chunk
 *  is proportional to the chunk, never to the document. */
const freshField = StateField.define<Word[]>({
  create: () => [],
  update(words, tr) {
    if (tr.effects.some((e) => e.is(clearFresh))) return []
    let next = words
    if (tr.docChanged && words.length)
      next = words
        .map((w) => ({ from: tr.changes.mapPos(w.from, 1), to: tr.changes.mapPos(w.to, -1) }))
        .filter((w) => w.to > w.from)
    if (tr.annotation(freshChunk) && tr.docChanged) {
      const added: Word[] = []
      tr.changes.iterChangedRanges((_a, _b, from, to) => {
        if (to <= from) return
        const text = tr.newDoc.sliceString(from, to)
        const re = /\S+/g
        let m: RegExpExecArray | null
        while ((m = re.exec(text))) {
          if (MARKS.test(m[0]))
            added.push({ from: from + m.index, to: from + m.index + m[0].length })
        }
      })
      next = (next === words ? [...words, ...added] : [...next, ...added]).slice(-MAX_WORDS)
    }
    return next
  }
})

function build(view: EditorView, words: Word[]): DecorationSet {
  const vis = view.visibleRanges
  const out: Range<Decoration>[] = []
  for (const w of words)
    if (vis.some((v) => w.from < v.to && w.to > v.from)) out.push(deco.range(w.from, w.to))
  return Decoration.set(out, true)
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    timer: ReturnType<typeof setTimeout> | null = null
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate): void {
      const words = u.state.field(freshField)
      if (!words.length) {
        this.decorations = Decoration.none
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        return
      }
      const added = u.transactions.some((t) => t.annotation(freshChunk))
      this.decorations = build(u.view, words)
      if (added || !this.timer) {
        if (this.timer) clearTimeout(this.timer)
        const view = u.view
        this.timer = setTimeout(() => {
          this.timer = null
          view.dispatch({ effects: clearFresh.of(null) })
        }, HOLD_MS)
      }
    }
    destroy(): void {
      if (this.timer) clearTimeout(this.timer)
    }
  },
  { decorations: (p) => p.decorations }
)

/** Annotation to attach to a transaction whose changes should fade in (no-op under reduced motion). */
export function freshAnnotations(): Annotation<boolean>[] {
  return prefersReducedMotion() ? [] : [freshChunk.of(true)]
}

export function freshExtension(): Extension {
  return [freshField, plugin]
}
