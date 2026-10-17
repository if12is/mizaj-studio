import type { EditorView } from '@codemirror/view'
import { ApiError } from '@renderer/api/client'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { clearSpellMarks, setSpellMarks } from '@renderer/editor/spelling'
import { issuesToMarks, type SpellIssueRaw } from '@renderer/editor/spellModel'
import { useEditorStore } from '@renderer/stores/editor'
import { useSettingsStore } from '@renderer/stores/settings'

export const SPELL_DEBOUNCE_MS = 1500
export const LARGE_DOC_CHARS = 30_000
const CHUNK_CHARS = 200_000

interface Range {
  from: number
  to: number
}

/** Whole doc for small documents / on demand; only the visible lines for large ones. */
export function rangesToCheck(
  docLength: number,
  visible: Range[],
  lineBounds: (pos: number) => Range,
  full: boolean
): Range[] {
  if (full || docLength <= LARGE_DOC_CHARS) return [{ from: 0, to: docLength }]
  const out: Range[] = []
  for (const r of visible) {
    const from = lineBounds(r.from).from
    const to = lineBounds(r.to).to
    const last = out[out.length - 1]
    if (last && from <= last.to) last.to = Math.max(last.to, to)
    else out.push({ from, to })
  }
  return out
}

export function useSpellCheck(getView: () => EditorView | null) {
  const settings = useSettingsStore()
  const editor = useEditorStore()
  let timer: ReturnType<typeof setTimeout> | null = null
  let warnedMissing = false

  const enabled = (): boolean => settings.values.spell_check_enabled !== 'false'
  const cats = (): string[] => {
    const c: string[] = []
    if (settings.values.spell_cat_spelling !== 'false') c.push('spelling')
    if (settings.values.spell_cat_pattern !== 'false') c.push('pattern')
    if (settings.values.spell_cat_punctuation !== 'false') c.push('punctuation')
    return c
  }
  const apiChecks = (): string[] => {
    const m: Record<string, string> = {
      spelling: 'dictionary',
      pattern: 'patterns',
      punctuation: 'punctuation'
    }
    return cats().map((c) => m[c])
  }

  function clear(): void {
    getView()?.dispatch({ effects: clearSpellMarks.of(null) })
  }

  async function check(full: boolean): Promise<void> {
    const view = getView()
    if (!view) return
    if (!enabled() || cats().length === 0) return clear()
    if (editor.runState === 'running' || editor.runState === 'waiting') return // don't fight a run
    const doc = view.state.doc
    const ranges = rangesToCheck(
      doc.length,
      view.visibleRanges.map((r) => ({ from: r.from, to: r.to })),
      (p) => {
        const l = doc.lineAt(Math.min(p, doc.length))
        return { from: l.from, to: l.to }
      },
      full
    )
    // split huge ranges on line boundaries
    const pieces: Range[] = []
    for (const r of ranges) {
      let from = r.from
      while (from < r.to) {
        let to = Math.min(r.to, from + CHUNK_CHARS)
        if (to < r.to) to = doc.lineAt(to).to
        pieces.push({ from, to })
        from = to + 1
      }
    }
    try {
      const results = await Promise.all(
        pieces.map((p) =>
          useApi().request<{ issues: SpellIssueRaw[] }>(
            'POST',
            '/api/spelling/check',
            { text: doc.sliceString(p.from, p.to), checks: apiChecks(), max_issues: 2000 },
            true
          )
        )
      )
      const v = getView()
      if (!v) return
      if (v.state.doc !== doc) return schedule() // text changed meanwhile: check again when idle
      const allowed = new Set(cats())
      results.forEach((r, i) => {
        const marks = issuesToMarks(
          r.issues.filter((x) => allowed.has(x.category)),
          pieces[i].from,
          doc.length
        )
        v.dispatch({ effects: setSpellMarks.of({ ranges: [pieces[i]], marks }) })
      })
    } catch (e) {
      if (!(e instanceof ApiError)) console.error('spell check failed', e)
      if (e instanceof ApiError && e.errorCode === 'ERR_SPELL_DICT_MISSING' && !warnedMissing) {
        warnedMissing = true
        notify(e.messageAr, { kind: 'info' })
      }
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void check(false), SPELL_DEBOUNCE_MS)
  }

  async function ignoreWord(word: string): Promise<void> {
    await useApi().request('POST', '/api/spelling/ignore', { word }, true)
  }
  async function addToDictionary(word: string): Promise<void> {
    try {
      await useApi().request(
        'POST',
        '/api/dictionary',
        { word_or_phrase: word, diacritized_form: word },
        true
      )
      notify('تمت إضافة الكلمة إلى قاموسك.', { kind: 'success' })
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e
    }
  }
  async function fetchSuggestions(word: string): Promise<string[]> {
    const r = await useApi().request<{ suggestions: string[] }>(
      'POST',
      '/api/spelling/suggest',
      { word },
      true
    )
    return r.suggestions
  }

  return {
    schedule,
    checkNow: (full = true) => {
      if (timer) clearTimeout(timer)
      return check(full)
    },
    clear,
    ignoreWord,
    addToDictionary,
    fetchSuggestions,
    dispose: () => timer && clearTimeout(timer)
  }
}
