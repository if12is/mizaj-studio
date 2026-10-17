/* eslint-disable no-misleading-character-class -- combining marks are intentionally in ranges */
import { isMark, stripMarks } from './arabic'

/** Pure model for diacritics-aware find & replace (7.2.3). */
export interface FindOptions {
  /** true: ignore diacritics in both text and query; false: marks must match exactly */
  ignoreMarks: boolean
  /** fold hamza/alef forms (أ إ آ ٱ -> ا), taa marbuta -> haa, alef maqsura -> yaa, drop tatweel */
  foldLetters: boolean
  wholeWord: boolean
  caseSensitive?: boolean
}

export interface FindMatch {
  from: number
  to: number
}

const FOLD: Record<string, string> = {
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ة: 'ه',
  ى: 'ي'
}
const TATWEEL = 'ـ'

interface Normalized {
  text: string
  /** map[i] = index in the original string of normalized char i */
  map: number[]
}

/** Normalize while remembering where every kept char came from. */
export function normalize(src: string, o: FindOptions): Normalized {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < src.length; i++) {
    let ch = src[i]
    if (o.ignoreMarks && isMark(ch)) continue
    if (o.foldLetters) {
      if (ch === TATWEEL) continue
      ch = FOLD[ch] ?? ch
    }
    if (!o.caseSensitive) ch = ch.toLowerCase()
    text += ch
    map.push(i)
  }
  return { text, map }
}

const isWordCh = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}_ـً-ْٰ]/u.test(ch)

/** All non-overlapping matches of `query` in `src` (positions in `src`). */
export function findAll(src: string, query: string, o: FindOptions, limit = 100_000): FindMatch[] {
  if (!query) return []
  const q = normalize(query, o).text
  if (!q) return []
  const n = normalize(src, o)
  const out: FindMatch[] = []
  let at = 0
  while (out.length < limit) {
    const i = n.text.indexOf(q, at)
    if (i < 0) break
    const j = i + q.length
    at = j
    const from = n.map[i]
    // include the marks that follow the last matched letter so a replacement swaps whole letters
    let to = n.map[j - 1] + 1
    if (o.ignoreMarks) while (to < src.length && isMark(src[to])) to++
    if (o.wholeWord) {
      const before = src[from - 1]
      const after = src[to]
      if (isWordCh(before) || isWordCh(after)) {
        at = i + 1
        continue
      }
    }
    out.push({ from, to })
  }
  return out
}

/** Replacement text according to the "keep / strip marks" choice. */
export function replacementText(replacement: string, stripReplacementMarks: boolean): string {
  return stripReplacementMarks ? stripMarks(replacement) : replacement
}

/** Next match at/after `pos` (wraps), or previous before `pos` when dir = -1. */
export function nextMatch(matches: FindMatch[], pos: number, dir: 1 | -1): number {
  if (!matches.length) return -1
  if (dir === 1) {
    const i = matches.findIndex((m) => m.from >= pos)
    return i < 0 ? 0 : i
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].from < pos) return i
  return matches.length - 1
}
