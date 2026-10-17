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
import { sentenceBounds } from './arabic'
import { WORD_RE, hasArabic } from './arabic'
import type { SpanLike } from './confidence'

export interface Suggestion {
  diacritized: string
  pos: string
}

export interface InspectorConfig {
  fetchSuggestions(bareWord: string): Promise<Suggestion[]>
  saveToDictionary(bareWord: string, form: string): Promise<void>
  /** `count` word occurrences of `bareWord` were changed manually through the inspector */
  onManualEdit(count: number, bareWord: string): void
  /** 7.1.7: report a marks-only correction; resolves to a suggestion when it was repeated */
  recordCorrection?(engineForm: string, userForm: string): Promise<CorrectionInfo | null>
  fetchCorrection?(bareWord: string): Promise<CorrectionInfo | null>
  acceptCorrection?(id: number): Promise<void>
  /** 7.5.1 */
  fetchIrab?(word: string, context: string, index: number): Promise<IrabInfo>
  /** 7.4.3 explicit action */
  addProperNoun?(bareWord: string, form: string): Promise<void>
  /** 7.8.2 (only when enabled and detected) */
  ollamaEnabled?(): boolean
  ollamaSuggest?(
    sentence: string
  ): Promise<{ accepted: boolean; text: string | null; reason: string | null }>
  /** 7.4.1 protected spans (apply-to-all never touches them) */
  protectedSpans?(state: EditorState): SpanLike[]
}

export interface CorrectionInfo {
  id: number
  word: string
  user_form: string
  count: number
  suggest: boolean
}

export interface IrabInfo {
  word: string
  certainty: string
  case: string | null
  sign: string | null
  role: string | null
  candidates: unknown[]
  context_used: boolean
  reason?: string
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

export function applyToAllSpec(
  state: EditorState,
  bare: string,
  newForm: string,
  skip?: (from: number, to: number) => boolean
) {
  const lines: { from: number; text: string }[] = []
  let pos = 0
  for (const text of state.doc.iterLines()) {
    lines.push({ from: pos, text })
    pos += text.length + 1
  }
  const { edits, words } = applyToAllEdits(lines, bare, newForm, skip)
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
  const corr = new Map<string, CorrectionInfo>()
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

        const currentWord = (): string => {
          const f = view.state.field(inspectorField)
          return f ? view.state.doc.sliceString(f.from, f.to) : ''
        }
        /** 7.1.7: tell the backend about a marks-only correction (it only suggests, never locks) */
        function recordCorrection(before: string): void {
          const after = currentWord()
          if (!cfg.recordCorrection || !after || after === before) return
          void cfg
            .recordCorrection(before, after)
            .then((info) => {
              if (info?.suggest) {
                corr.set(bare, info)
                const f = view.state.field(inspectorField)
                if (f) view.dispatch({ effects: setInspector.of({ ...f }) }) // rebuild the popover
              }
            })
            .catch(() => undefined)
        }

        function applyKey(key: HarakaKey): void {
          const before = currentWord()
          const spec = applyHarakaSpec(view.state, v.from, v.to, v.letter, key)
          if (spec) {
            view.dispatch(spec)
            cfg.onManualEdit(1, bare)
            recordCorrection(before)
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
                const before = view.state.doc.sliceString(f, t)
                view.dispatch(replaceWordSpec(view.state, f, t, s.diacritized))
                cfg.onManualEdit(1, bare)
                recordCorrection(before)
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
              const spans = cfg.protectedSpans?.(view.state) ?? []
              const r = applyToAllSpec(
                view.state,
                bare,
                form,
                spans.length ? (a, b) => spans.some((s) => a < s.to && b > s.from) : undefined
              )
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
        if (cfg.addProperNoun) {
          actions.append(
            btn(
              'إضافة كعَلَم',
              'add-proper-noun',
              () => void cfg.addProperNoun?.(bare, view.state.doc.sliceString(v.from, v.to)),
              'mi-act'
            )
          )
        }
        dom.append(actions)

        // 7.1.7: a suggestion built from the user's earlier identical corrections
        const corrBox = document.createElement('div')
        corrBox.className = 'mi-corr'
        corrBox.dataset.testid = 'correction-suggestion'
        corrBox.hidden = true
        dom.append(corrBox)
        const showCorr = (info: CorrectionInfo): void => {
          corrBox.hidden = false
          corrBox.replaceChildren()
          const t = document.createElement('div')
          t.textContent = `اقتراح من تصحيحاتك السابقة: ${info.user_form} (×${info.count})`
          corrBox.append(
            t,
            btn(
              'تطبيق',
              'corr-apply',
              () => {
                view.dispatch(replaceWordSpec(view.state, v.from, v.to, info.user_form))
                cfg.onManualEdit(1, bare)
              },
              'mi-act'
            ),
            btn(
              'إضافة للقاموس',
              'corr-add-dict',
              () => {
                void cfg.acceptCorrection?.(info.id).then(() => {
                  corr.delete(bare)
                  corrBox.hidden = true
                })
              },
              'mi-act'
            )
          )
        }
        const known = corr.get(bare)
        if (known) showCorr(known)
        else
          void cfg
            .fetchCorrection?.(bare)
            .then((info) => info?.suggest && showCorr(info))
            .catch(() => undefined)

        // 7.5.1: i'rab explanation (honest about uncertainty)
        if (cfg.fetchIrab) {
          const irabBox = document.createElement('div')
          irabBox.className = 'mi-irab'
          irabBox.dataset.testid = 'irab-panel'
          irabBox.hidden = true
          const tabs = document.createElement('div')
          tabs.className = 'mi-tabs'
          tabs.append(
            btn(
              'الإعراب',
              'inspector-tab-irab',
              () => {
                irabBox.hidden = !irabBox.hidden
                if (irabBox.hidden || irabBox.dataset.loaded) return
                irabBox.dataset.loaded = '1'
                irabBox.textContent = 'جاري التحليل...'
                const sb = sentenceBounds(view.state.doc, v.from)
                const sentence = view.state.doc.sliceString(sb.from, sb.to)
                const toks = [...sentence.matchAll(WORD_RE)].filter((m) => hasArabic(m[0]))
                const idx = Math.max(
                  0,
                  toks.findIndex((m) => (m.index ?? 0) === v.from - sb.from)
                )
                void cfg
                  .fetchIrab?.(word, sentence, idx)
                  .then((r) => renderIrab(irabBox, r))
                  .catch(() => {
                    irabBox.textContent = 'تعذر تحليل الإعراب.'
                  })
              },
              'mi-act'
            )
          )
          dom.append(tabs, irabBox)
        }

        // 7.8.2: optional local second opinion, only when enabled and detected
        if (cfg.ollamaEnabled?.() && cfg.ollamaSuggest) {
          const box = document.createElement('div')
          box.className = 'mi-ollama'
          box.dataset.testid = 'ollama-box'
          const ask = btn(
            'رأي ثانٍ (Ollama محلي)',
            'ollama-opinion',
            () => {
              const sb = sentenceBounds(view.state.doc, v.from)
              const sentence = view.state.doc.sliceString(sb.from, sb.to)
              box.append(
                Object.assign(document.createElement('div'), { textContent: 'جاري الاستشارة...' })
              )
              void cfg
                .ollamaSuggest?.(sentence)
                .then((r) => {
                  box.lastElementChild?.remove()
                  if (!r.accepted || !r.text) {
                    box.append(
                      Object.assign(document.createElement('div'), {
                        textContent: `لا اقتراح (${r.reason ?? 'غير مقبول'})`
                      })
                    )
                    return
                  }
                  const out = document.createElement('div')
                  out.dataset.testid = 'ollama-diff'
                  out.className = 'mi-diff'
                  out.append(renderWordDiff(sentence, r.text))
                  const suggestion = r.text
                  out.append(
                    btn(
                      'تطبيق اقتراح Ollama',
                      'ollama-apply',
                      () => {
                        const cur = sentenceBounds(view.state.doc, view.state.selection.main.head)
                        const edits = diffMarkEdits(
                          view.state.doc.sliceString(cur.from, cur.to),
                          suggestion,
                          cur.from
                        )
                        if (edits) view.dispatch(editsToSpec(view.state, edits, 'tashkeel.ollama'))
                      },
                      'mi-act'
                    )
                  )
                  box.append(out)
                })
                .catch(() => {
                  box.lastElementChild?.remove()
                  box.append(
                    Object.assign(document.createElement('div'), {
                      textContent: 'تعذر الاتصال بـ Ollama المحلي.'
                    })
                  )
                })
            },
            'mi-act'
          )
          box.append(ask)
          dom.append(box)
        }
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

function renderIrab(box: HTMLElement, r: IrabInfo): void {
  box.replaceChildren()
  const line = (t: string): void => {
    const d = document.createElement('div')
    d.textContent = t
    box.append(d)
  }
  if (r.certainty === 'unknown' || (!r.case && !r.role)) {
    line('غير متأكد')
    if (r.reason) line(r.reason)
    return
  }
  const label: Record<string, string> = { high: 'مرتفعة', medium: 'متوسطة', low: 'منخفضة' }
  if (r.role) line(`الموقع الإعرابي: ${r.role}`)
  if (r.case) line(`الحالة: ${r.case}${r.sign ? ` — علامتها ${r.sign}` : ''}`)
  line(`درجة اليقين: ${label[r.certainty] ?? r.certainty}${r.context_used ? '' : ' (بدون سياق)'}`)
  if (r.certainty === 'low') line('غير متأكد: قد توجد أوجه إعراب أخرى.')
  if (r.reason) line(r.reason)
}

/** Word-level diff view (original struck through, suggestion highlighted). */
export function renderWordDiff(a: string, b: string): HTMLElement {
  const wa = a.split(/(\s+)/)
  const wb = b.split(/(\s+)/)
  const root = document.createElement('div')
  root.className = 'mi-diff-body'
  const n = Math.max(wa.length, wb.length)
  for (let i = 0; i < n; i++) {
    const x = wa[i] ?? ''
    const y = wb[i] ?? ''
    if (x === y) root.append(document.createTextNode(y))
    else {
      if (x.trim()) root.append(Object.assign(document.createElement('del'), { textContent: x }))
      root.append(Object.assign(document.createElement('ins'), { textContent: y }))
    }
  }
  return root
}
