import { normalizeArabic } from './normalize'

/**
 * Fuzzy score of `query` against `text` (both normalised here); null = no match, higher = better.
 * The query is split on spaces and EVERY token must match, in any order. A token matches as
 *  - a substring (best at a word start / the very start of the text), or
 *  - an in-order subsequence of the characters (typo-tolerant, scored by how tight it is).
 * The empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalizeArabic(query)
  if (!q) return 0
  const t = normalizeArabic(text)
  let total = 0
  for (const tok of q.split(' ')) {
    const s = tokenScore(tok, t)
    if (s === null) return null
    total += s
  }
  // shorter texts rank above long ones for the same match
  return total - Math.min(t.length, 200) / 200
}

function tokenScore(tok: string, t: string): number | null {
  const i = t.indexOf(tok)
  if (i >= 0) {
    const wordStart = i === 0 || t[i - 1] === ' '
    return 100 + (wordStart ? 40 : 0) + (i === 0 ? 20 : 0) - Math.min(i, 30) / 3
  }
  if (tok.length < 3) return null // short tokens must match exactly: avoid noise
  let pos = -1
  let first = -1
  for (const ch of tok) {
    pos = t.indexOf(ch, pos + 1)
    if (pos < 0) return null
    if (first < 0) first = pos
  }
  const span = pos - first + 1
  if (span > tok.length * 3) return null
  return 40 - (span - tok.length) * 3 - Math.min(first, 30) / 3
}

/** Best score over several fields (title first, then keywords…); null if none match. */
export function bestScore(query: string, fields: (string | undefined)[]): number | null {
  let best: number | null = null
  fields.forEach((f, idx) => {
    if (!f) return
    const s = fuzzyScore(query, f)
    if (s === null) return
    const adj = s - idx * 5 // secondary fields count slightly less
    if (best === null || adj > best) best = adj
  })
  return best
}
