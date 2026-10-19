import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/** Highlight of the sentence being read aloud (Piper). Pure view state: never touches the text. */
export const setReadRange = StateEffect.define<{ from: number; to: number } | null>()

const mark = Decoration.mark({ class: 'cm-reading' })

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setReadRange)) continue
      const r = e.value
      const len = tr.state.doc.length
      set =
        r && Math.min(r.from, len) < Math.min(r.to, len)
          ? Decoration.set([mark.range(Math.min(r.from, len), Math.min(r.to, len))])
          : Decoration.none
    }
    return set
  },
  provide: (f) => EditorView.decorations.from(f)
})

const theme = EditorView.baseTheme({
  '.cm-reading': { backgroundColor: 'rgba(16, 185, 129, 0.28)', borderRadius: '2px' }
})

export const readAloudExtension = (): Extension => [field, theme]

export function highlightRead(view: EditorView, r: { from: number; to: number } | null): void {
  const len = view.state.doc.length
  view.dispatch({
    effects: r
      ? [setReadRange.of(r), EditorView.scrollIntoView(Math.min(r.from, len), { y: 'nearest' })]
      : [setReadRange.of(null)]
  })
}
