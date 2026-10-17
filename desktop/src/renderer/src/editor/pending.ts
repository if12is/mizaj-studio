import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type TransactionSpec
} from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import { diffMarkEdits, mapSelection } from './markEdits'
import { addConfidence, type ConfMark, type ConfWord } from './confidence'
import { allowQuranChange } from './quran'

/** A proposed (not yet applied) tashkeel result for one paragraph (7.2.2). */
export interface PendingItem {
  id: number
  from: number
  to: number
  original: string
  proposed: string
  /** low-confidence words of `proposed` (offsets relative to it) */
  words?: ConfWord[]
}

export const addPending = StateEffect.define<PendingItem[]>()
export const removePending = StateEffect.define<number[]>()
export const clearPending = StateEffect.define<null>()

export const pendingField = StateField.define<PendingItem[]>({
  create: () => [],
  update(items, tr) {
    if (tr.docChanged && items.length) {
      const kept: PendingItem[] = []
      for (const it of items) {
        const from = tr.changes.mapPos(it.from, 1)
        const to = tr.changes.mapPos(it.to, -1)
        // an edit inside the paragraph invalidates the proposal
        if (to >= from && tr.newDoc.sliceString(from, to) === it.original)
          kept.push({ ...it, from, to })
      }
      items = kept
    }
    for (const e of tr.effects) {
      if (e.is(addPending)) {
        const ids = new Set(e.value.map((x) => x.id))
        items = [...items.filter((i) => !ids.has(i.id)), ...e.value].sort((a, b) => a.from - b.from)
      } else if (e.is(removePending)) items = items.filter((i) => !e.value.includes(i.id))
      else if (e.is(clearPending)) items = []
    }
    return items
  }
})

/** Single transaction accepting the given items (one undo step). */
export function acceptSpec(state: EditorState, items: PendingItem[]): TransactionSpec | null {
  const ok = items.filter((i) => state.doc.sliceString(i.from, i.to) === i.original)
  if (!ok.length) return null
  const fine = ok.flatMap((i) => diffMarkEdits(i.original, i.proposed, i.from) ?? [])
  // low-confidence marks at their positions in the NEW document
  const marks: ConfMark[] = []
  let shift = 0
  for (const i of [...ok].sort((a, b) => a.from - b.from)) {
    const nf = i.from + shift
    for (const w of i.words ?? []) {
      if (w.u16_end > i.proposed.length) continue
      marks.push({
        from: nf + w.u16_start,
        to: nf + w.u16_end,
        word: i.proposed.slice(w.u16_start, w.u16_end),
        confidence: w.confidence,
        irab: w.irab_confidence,
        reviewed: false
      })
    }
    shift += i.proposed.length - (i.to - i.from)
  }
  return {
    changes: ok.map((i) => ({ from: i.from, to: i.to, insert: i.proposed })),
    selection: mapSelection(state.selection, fine),
    effects: marks.length
      ? [removePending.of(ok.map((i) => i.id)), addConfidence.of(marks)]
      : removePending.of(ok.map((i) => i.id)),
    userEvent: 'tashkeel.accept',
    annotations: [isolateHistory.of('full'), allowQuranChange.of(true)]
  }
}

export function acceptAll(view: EditorView): boolean {
  const spec = acceptSpec(view.state, view.state.field(pendingField))
  if (!spec) return false
  view.dispatch(spec)
  return true
}
export function rejectAll(view: EditorView): boolean {
  if (!view.state.field(pendingField).length) return false
  view.dispatch({ effects: clearPending.of(null) })
  return true
}

class PendingWidget extends WidgetType {
  constructor(readonly item: PendingItem) {
    super()
  }
  eq(o: PendingWidget): boolean {
    return (
      o.item.id === this.item.id &&
      o.item.proposed === this.item.proposed &&
      o.item.to === this.item.to
    )
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-pending-new'
    wrap.dataset.testid = 'pending-preview'
    const text = document.createElement('span')
    text.className = 'cm-pending-text'
    text.textContent = this.item.proposed
    wrap.append(text)
    const mk = (label: string, tid: string, cls: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.className = cls
      b.dataset.testid = tid
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', fn)
      return b
    }
    wrap.append(
      mk('قبول', 'pending-accept', 'cm-pending-btn cm-pending-ok', () => {
        const cur = view.state.field(pendingField).find((i) => i.id === this.item.id)
        const spec = cur && acceptSpec(view.state, [cur])
        if (spec) view.dispatch(spec)
      }),
      mk('رفض', 'pending-reject', 'cm-pending-btn', () =>
        view.dispatch({ effects: removePending.of([this.item.id]) })
      )
    )
    return wrap
  }
  ignoreEvent(): boolean {
    return false
  }
}

export interface PendingConfig {
  onChange(count: number): void
}

export function pendingExtension(cfg: PendingConfig): Extension[] {
  let last: PendingItem[] | null = null
  return [
    pendingField,
    EditorView.decorations.compute([pendingField], (state): DecorationSet => {
      const out: import('@codemirror/state').Range<Decoration>[] = []
      for (const it of state.field(pendingField)) {
        if (it.to > it.from)
          out.push(Decoration.mark({ class: 'cm-pending-old' }).range(it.from, it.to))
        out.push(Decoration.widget({ widget: new PendingWidget(it), side: 1 }).range(it.to))
      }
      return Decoration.set(out, true)
    }),
    EditorView.updateListener.of((u) => {
      const p = u.state.field(pendingField)
      if (p !== last) {
        last = p
        cfg.onChange(p.length)
      }
    }),
    Prec.high(
      keymap.of([
        {
          key: 'Escape',
          run: (v) => rejectAll(v)
        }
      ])
    )
  ]
}
