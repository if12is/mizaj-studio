import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view'
import {
  applyHaraka,
  HARAKAT,
  letterSlots,
  setLetterMarks,
  stripMarks,
  wordBoundsAt,
  type HarakaKey
} from './arabic'
import { applyToAllEdits, diffMarkEdits, editsToSpec } from './markEdits'

export interface Suggestion {
  diacritized: string
  pos: string
}

export interface InspectorConfig {
  fetchSuggestions(bareWord: string): Promise<Suggestion[]>
  saveToDictionary(bareWord: string, form: string): Promise<void>
  /** `count` word occurrences of `bareWord` were changed manually through the inspector */
  onManualEdit(count: number, bareWord: string): void
}

interface InspectorValue {
  from: number
  to: number
  letter: number
}

export const setInspector = StateEffect.define<InspectorValue | null>()

export const inspectorField = StateField.define<InspectorValue | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setInspector)) return e.value
    if (!value) return null
    if (tr.docChanged) {
      const b = wordBoundsAt(tr.newDoc, tr.changes.mapPos(value.from, 1))
      if (!b) return null
      value = { ...value, from: b.from, to: b.to }
    }
    if (tr.selection) {
      const h = tr.newSelection.main.head
      if (h < value.from || h > value.to) return null
    }
    return value
  }
})

/** Edit the word at [from,to) so that it becomes `newWord` (one transaction). */
export function replaceWordSpec(state: EditorState, from: number, to: number, newWord: string) {
  const old = state.doc.sliceString(from, to)
  const edits = diffMarkEdits(old, newWord, from)
  if (edits) return editsToSpec(state, edits, 'tashkeel.word')
  // base letters differ (should not happen): plain replacement
  return { changes: { from, to, insert: newWord }, userEvent: 'tashkeel.word' }
}

export function applyHarakaSpec(
  state: EditorState,
  from: number,
  to: number,
  letterIdx: number,
  key: HarakaKey
) {
  const word = state.doc.sliceString(from, to)
  const slot = letterSlots(word)[letterIdx]
  if (!slot) return null
  const next = setLetterMarks(word, letterIdx, applyHaraka(slot.marks, key))
  return replaceWordSpec(state, from, to, next)
}

export function applyToAllSpec(state: EditorState, bare: string, newForm: string) {
  const lines: { from: number; text: string }[] = []
  let pos = 0
  for (const text of state.doc.iterLines()) {
    lines.push({ from: pos, text })
    pos += text.length + 1
  }
  const { edits, words } = applyToAllEdits(lines, bare, newForm)
  if (!edits.length) return null
  return { spec: editsToSpec(state, edits, 'tashkeel.word'), words }
}

export function openInspectorAt(view: EditorView, pos = view.state.selection.main.head): boolean {
  const b = wordBoundsAt(view.state.doc, pos)
  if (!b) return false
  view.dispatch({ effects: setInspector.of({ from: b.from, to: b.to, letter: 0 }) })
  return true
}

export function closeInspector(view: EditorView): boolean {
  if (!view.state.field(inspectorField, false)) return false
  view.dispatch({ effects: setInspector.of(null) })
  return true
}

function btn(label: string, testid: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.className = cls
  b.dataset.testid = testid
  b.addEventListener('mousedown', (e) => e.preventDefault()) // keep editor focus/selection
  b.addEventListener('click', onClick)
  return b
}

export function inspectorExtension(cfg: InspectorConfig) {
  const cache = new Map<string, Promise<Suggestion[]>>()
  const suggest = (bare: string): Promise<Suggestion[]> => {
    let p = cache.get(bare)
    if (!p) {
      p = cfg.fetchSuggestions(bare).catch(() => [])
      cache.set(bare, p)
    }
    return p
  }

  function tooltipFor(v: InspectorValue): Tooltip {
    return {
      pos: v.from,
      end: v.to,
      above: false,
      strictSide: true,
      arrow: true,
      create(view) {
        const dom = document.createElement('div')
        dom.className = 'mizaj-inspector'
        dom.dir = 'rtl'
        dom.dataset.testid = 'inspector'
        const word = view.state.doc.sliceString(v.from, v.to)
        const bare = stripMarks(word)

        const head = document.createElement('div')
        head.className = 'mi-word'
        head.textContent = word
        dom.append(head)

        const letters = document.createElement('div')
        letters.className = 'mi-letters'
        letterSlots(word).forEach((s, i) => {
          const b = btn(
            s.letter + s.marks,
            'inspector-letter',
            () => view.dispatch({ effects: setInspector.of({ ...v, letter: i }) }),
            i === v.letter ? 'sel' : ''
          )
          letters.append(b)
        })
        dom.append(letters)

        const pal = document.createElement('div')
        pal.className = 'mi-palette'
        for (const h of HARAKAT) {
          pal.append(btn('ـ' + h.mark, 'harakat-btn', () => applyKey(h.key), 'mi-h'))
          pal.lastElementChild?.setAttribute('data-key', h.key)
        }
        pal.append(btn('✕', 'harakat-btn', () => applyKey('clear'), 'mi-h'))
        pal.lastElementChild?.setAttribute('data-key', 'clear')
        dom.append(pal)

        function applyKey(key: HarakaKey): void {
          const spec = applyHarakaSpec(view.state, v.from, v.to, v.letter, key)
          if (spec) {
            view.dispatch(spec)
            cfg.onManualEdit(1, bare)
          }
        }

        const sug = document.createElement('div')
        sug.className = 'mi-suggestions'
        dom.append(sug)
        void suggest(bare).then((list) => {
          for (const s of list) {
            const b = btn(
              s.pos ? `${s.diacritized} — ${s.pos}` : s.diacritized,
              'inspector-suggestion',
              () => {
                const cur = wordBoundsAt(view.state.doc, view.state.selection.main.head)
                const f = cur?.from ?? v.from
                const t = cur?.to ?? v.to
                view.dispatch(replaceWordSpec(view.state, f, t, s.diacritized))
                cfg.onManualEdit(1, bare)
              },
              'mi-sug'
            )
            b.dataset.form = s.diacritized
            sug.append(b)
          }
        })

        const actions = document.createElement('div')
        actions.className = 'mi-actions'
        actions.append(
          btn(
            'تعميم على كامل المقال',
            'apply-all',
            () => {
              const form = view.state.doc.sliceString(v.from, v.to)
              const r = applyToAllSpec(view.state, bare, form)
              if (r) {
                view.dispatch(r.spec)
                cfg.onManualEdit(r.words, bare)
              }
            },
            'mi-act'
          ),
          btn(
            'حفظ في قاموسي',
            'save-dict',
            () => void cfg.saveToDictionary(bare, view.state.doc.sliceString(v.from, v.to)),
            'mi-act'
          )
        )
        dom.append(actions)
        return { dom, offset: { x: 0, y: 4 } }
      }
    }
  }

  return [
    inspectorField,
    showTooltip.computeN([inspectorField], (state) => {
      const v = state.field(inspectorField)
      return v ? [tooltipFor(v)] : []
    })
  ]
}
