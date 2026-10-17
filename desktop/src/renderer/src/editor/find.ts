import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import { findAll, nextMatch, replacementText, type FindMatch, type FindOptions } from './findModel'

export interface FindState {
  query: string
  replacement: string
  options: FindOptions
  stripReplacementMarks: boolean
  matches: FindMatch[]
  current: number
}

export const defaultFindOptions: FindOptions = {
  ignoreMarks: true,
  foldLetters: false,
  wholeWord: false
}

const empty: FindState = {
  query: '',
  replacement: '',
  options: defaultFindOptions,
  stripReplacementMarks: false,
  matches: [],
  current: -1
}

export const setFind = StateEffect.define<Partial<Omit<FindState, 'matches' | 'current'>>>()
const setCurrent = StateEffect.define<number>()

function recompute(doc: string, s: FindState, cursor: number): FindState {
  const matches = s.query ? findAll(doc, s.query, s.options) : []
  return { ...s, matches, current: matches.length ? nextMatch(matches, cursor, 1) : -1 }
}

export const findField = StateField.define<FindState>({
  create: () => empty,
  update(s, tr) {
    let next = s
    let force = false
    for (const e of tr.effects) {
      if (e.is(setFind)) {
        next = { ...next, ...e.value }
        force = true
      } else if (e.is(setCurrent)) next = { ...next, current: e.value }
    }
    if ((force || tr.docChanged) && next.query) {
      next = recompute(tr.newDoc.toString(), next, tr.newSelection.main.from)
    } else if (force && !next.query) next = { ...next, matches: [], current: -1 }
    return next
  }
})

function select(view: EditorView, idx: number): void {
  const s = view.state.field(findField)
  const m = s.matches[idx]
  if (!m) return
  view.dispatch({
    selection: { anchor: m.from, head: m.to },
    effects: [setCurrent.of(idx), EditorView.scrollIntoView(m.from, { y: 'center' })]
  })
}

export function findStep(view: EditorView, dir: 1 | -1): boolean {
  const s = view.state.field(findField)
  if (!s.matches.length) return false
  const pos = dir === 1 ? view.state.selection.main.to : view.state.selection.main.from
  const idx = dir === 1 ? nextMatch(s.matches, pos, 1) : nextMatch(s.matches, pos, -1)
  select(view, idx)
  return true
}

/** Replace the current match (one transaction). */
export function replaceCurrent(view: EditorView): boolean {
  const s = view.state.field(findField)
  const m = s.matches[s.current]
  if (!m) return false
  const ins = replacementText(s.replacement, s.stripReplacementMarks)
  view.dispatch({
    changes: { from: m.from, to: m.to, insert: ins },
    selection: { anchor: m.from + ins.length },
    userEvent: 'find.replace',
    annotations: [isolateHistory.of('full')]
  })
  return true
}

/** Replace every match in ONE transaction (one undo step). Returns the count. */
export function replaceAll(view: EditorView): number {
  const s = view.state.field(findField)
  if (!s.matches.length) return 0
  const ins = replacementText(s.replacement, s.stripReplacementMarks)
  view.dispatch({
    changes: s.matches.map((m) => ({ from: m.from, to: m.to, insert: ins })),
    userEvent: 'find.replaceAll',
    annotations: [isolateHistory.of('full')]
  })
  return s.matches.length
}

const matchMark = Decoration.mark({ class: 'cm-find-match' })
const currentMark = Decoration.mark({ class: 'cm-find-current' })

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    constructor(view: EditorView) {
      this.build(view)
    }
    update(u: ViewUpdate): void {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.startState.field(findField) !== u.state.field(findField)
      )
        this.build(u.view)
    }
    build(view: EditorView): void {
      const s = view.state.field(findField)
      const out: import('@codemirror/state').Range<Decoration>[] = []
      for (const r of view.visibleRanges) {
        for (let i = 0; i < s.matches.length; i++) {
          const m = s.matches[i]
          if (m.to < r.from) continue
          if (m.from > r.to) break
          out.push((i === s.current ? currentMark : matchMark).range(m.from, m.to))
        }
      }
      this.decorations = Decoration.set(out, true)
    }
  },
  { decorations: (v) => v.decorations }
)

export interface FindConfig {
  onOpen(): void
  onClose(): void
  onChange(info: { count: number; current: number }): void
}

export function findExtension(cfg: FindConfig): Extension[] {
  let last: FindState | null = null
  return [
    findField,
    highlighter,
    ViewPlugin.fromClass(
      class {
        update(u: ViewUpdate): void {
          const s = u.state.field(findField)
          if (s !== last) {
            last = s
            cfg.onChange({ count: s.matches.length, current: s.current })
          }
        }
      }
    ),
    Prec.high(
      keymap.of([
        {
          key: 'Mod-f',
          preventDefault: true,
          run: () => {
            cfg.onOpen()
            return true
          }
        },
        { key: 'F3', preventDefault: true, run: (v) => findStep(v, 1) },
        { key: 'Shift-F3', preventDefault: true, run: (v) => findStep(v, -1) }
      ])
    )
  ]
}
