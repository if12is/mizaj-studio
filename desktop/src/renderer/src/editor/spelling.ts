import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  type Tooltip
} from '@codemirror/view'
import { marksToDecoSpecs, mergeMarks, neighbourMark, type SpellMark } from './spellModel'
import { safeEditSpec } from './safeEdit'

export interface SpellConfig {
  fetchSuggestions(word: string): Promise<string[]>
  ignore(word: string): Promise<void>
  addToDictionary(word: string): Promise<void>
  /** called (throttled by the consumer) whenever the issue list changes */
  onIssues(marks: SpellMark[]): void
  onFullCheck(): void
}

type SetPayload = { ranges: { from: number; to: number }[]; marks: SpellMark[] }
export const setSpellMarks = StateEffect.define<SetPayload>()
export const clearSpellMarks = StateEffect.define<null>()
export const removeSpellWord = StateEffect.define<string>()
const openSpellAt = StateEffect.define<{ from: number; to: number } | null>()

export const spellField = StateField.define<SpellMark[]>({
  create: () => [],
  update(marks, tr) {
    if (tr.docChanged && marks.length) {
      const kept: SpellMark[] = []
      for (const m of marks) {
        const from = tr.changes.mapPos(m.from, 1)
        const to = tr.changes.mapPos(m.to, -1)
        // an edit inside the word invalidates the diagnosis
        if (to > from && tr.newDoc.sliceString(from, to) === m.word) kept.push({ ...m, from, to })
      }
      marks = kept
    }
    for (const e of tr.effects) {
      if (e.is(clearSpellMarks)) marks = []
      else if (e.is(setSpellMarks)) marks = mergeMarks(marks, e.value.ranges, e.value.marks)
      else if (e.is(removeSpellWord)) marks = marks.filter((m) => m.word !== e.value)
    }
    return marks
  }
})

const activeField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(openSpellAt)) return e.value
    if (!v) return null
    if (tr.docChanged) return null
    if (tr.selection) {
      const h = tr.newSelection.main.head
      if (h < v.from || h > v.to) return null
    }
    return v
  }
})

export function findMarkAt(marks: SpellMark[], pos: number): SpellMark | undefined {
  return marks.find((m) => pos >= m.from && pos <= m.to)
}

function openTooltipFor(view: EditorView, m: SpellMark): void {
  view.dispatch({ effects: openSpellAt.of({ from: m.from, to: m.to }) })
}

export function goToIssue(view: EditorView, dir: 1 | -1): boolean {
  const marks = view.state.field(spellField)
  const m = neighbourMark(marks, view.state.selection.main.head, dir)
  if (!m) return false
  view.dispatch({
    selection: { anchor: m.from, head: m.to },
    effects: [
      EditorView.scrollIntoView(m.from, { y: 'center' }),
      openSpellAt.of({ from: m.from, to: m.to })
    ]
  })
  return true
}

function btn(label: string, testid: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.className = cls
  b.dataset.testid = testid
  b.addEventListener('mousedown', (e) => e.preventDefault())
  b.addEventListener('click', onClick)
  return b
}

function tooltipFor(
  cfg: SpellConfig,
  v: { from: number; to: number },
  view: EditorView
): Tooltip | null {
  const m = view.state.field(spellField).find((x) => x.from === v.from && x.to === v.to)
  if (!m) return null
  return {
    pos: m.from,
    end: m.to,
    above: false,
    strictSide: true,
    arrow: false,
    create(v2) {
      const dom = document.createElement('div')
      dom.className = 'mizaj-spell-tip'
      dom.dir = 'rtl'
      dom.dataset.testid = 'spell-tooltip'
      const msg = document.createElement('div')
      msg.className = 'mst-msg'
      msg.textContent = m.message_ar
      dom.append(msg)
      const list = document.createElement('div')
      list.className = 'mst-list'
      dom.append(list)

      const accept = (s: string): void => {
        // verify the range still holds the diagnosed word, then ONE transaction
        const spec = safeEditSpec(v2.state, m.from, m.to, m.word, s, 'spelling.accept')
        if (spec) v2.dispatch(spec)
      }
      const fill = (sugg: string[]): void => {
        list.replaceChildren()
        for (const s of sugg) {
          const label = s === '' ? 'حذف' : s
          const b = btn(label, 'spell-suggestion', 'mst-sug', () => accept(s))
          b.dataset.value = s
          list.append(b)
        }
      }
      if (m.suggestions.length) fill(m.suggestions)
      else
        void cfg.fetchSuggestions(m.word).then(fill, () => {
          /* no suggestions */
        })

      const actions = document.createElement('div')
      actions.className = 'mst-actions'
      actions.append(
        btn('تجاهل', 'spell-ignore', 'mst-act', () => {
          void cfg.ignore(m.word).then(() => v2.dispatch({ effects: removeSpellWord.of(m.word) }))
        })
      )
      if (m.code === 'SPELL_UNKNOWN') {
        actions.append(
          btn('إضافة للقاموس', 'spell-add-dict', 'mst-act', () => {
            void cfg
              .addToDictionary(m.word)
              .then(() => v2.dispatch({ effects: removeSpellWord.of(m.word) }))
          })
        )
      }
      dom.append(actions)
      return { dom, offset: { x: 0, y: 4 } }
    }
  }
}

export function spellingExtension(cfg: SpellConfig): Extension[] {
  let lastMarks: SpellMark[] = []
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  return [
    spellField,
    activeField,
    EditorView.decorations.compute([spellField], (state) =>
      Decoration.set(
        marksToDecoSpecs(state.field(spellField)).map((d) =>
          Decoration.mark({ class: d.class }).range(d.from, d.to)
        ),
        true
      )
    ),
    showTooltip.computeN([activeField, spellField], (state) => {
      const v = state.field(activeField)
      if (!v) return []
      const m = state.field(spellField).find((x) => x.from === v.from && x.to === v.to)
      if (!m) return []
      // Tooltip needs a view only for creation; create() receives it, so pass a lazy shim.
      return [lazyTooltip(cfg, v)]
    }),
    // keeps the issues panel in sync
    ViewPlugin.fromClass(
      class {
        update(u: import('@codemirror/view').ViewUpdate): void {
          const marks = u.state.field(spellField)
          if (marks !== lastMarks) {
            lastMarks = marks
            cfg.onIssues(marks)
          }
        }
      }
    ),
    EditorView.domEventHandlers({
      mouseover(e, view) {
        const el = (e.target as HTMLElement).closest?.('.cm-spell')
        if (hoverTimer) clearTimeout(hoverTimer)
        hoverTimer = null
        if (!el) return
        hoverTimer = setTimeout(() => {
          try {
            const m = findMarkAt(view.state.field(spellField), view.posAtDOM(el, 0))
            if (m) openTooltipFor(view, m)
          } catch {
            /* element no longer in the document */
          }
        }, 350)
      },
      mouseout() {
        if (hoverTimer) clearTimeout(hoverTimer)
        hoverTimer = null
      },
      mouseup(e, view) {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
        if (pos === null) return
        const m = findMarkAt(view.state.field(spellField), pos)
        if (m) setTimeout(() => openTooltipFor(view, m))
      }
    }),
    Prec.high(
      keymap.of([
        { key: 'F8', preventDefault: true, run: (v) => goToIssue(v, 1) },
        { key: 'Shift-F8', preventDefault: true, run: (v) => goToIssue(v, -1) },
        {
          key: 'Mod-Shift-l',
          preventDefault: true,
          run: () => {
            cfg.onFullCheck()
            return true
          }
        },
        {
          key: 'Escape',
          run: (v) => {
            if (!v.state.field(activeField)) return false
            v.dispatch({ effects: openSpellAt.of(null) })
            return true
          }
        }
      ])
    )
  ]
}

/** A Tooltip whose content is built from the live view at create() time. */
function lazyTooltip(cfg: SpellConfig, v: { from: number; to: number }): Tooltip {
  return {
    pos: v.from,
    end: v.to,
    above: false,
    strictSide: true,
    arrow: true,
    create(view) {
      const t = tooltipFor(cfg, v, view)
      return t ? t.create(view) : { dom: document.createElement('div') }
    }
  }
}
