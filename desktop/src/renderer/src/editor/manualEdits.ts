/** Per-document record of words edited manually through the Word Inspector. */
export interface ManualEdits {
  count: number
  words: string[]
}

export const MAX_TRACKED_WORDS = 1000
export const manualEditsKey = (docId: number): string => `manual_edits:${docId}`

export const emptyManualEdits = (): ManualEdits => ({ count: 0, words: [] })

/** Tolerant parse of the persisted JSON string (settings value). */
export function parseManualEdits(raw: string | undefined | null): ManualEdits {
  if (!raw) return emptyManualEdits()
  try {
    const v = JSON.parse(raw) as Partial<ManualEdits>
    const count =
      Number.isFinite(v.count) && (v.count as number) > 0 ? Math.floor(v.count as number) : 0
    const words = Array.isArray(v.words)
      ? v.words.filter((w): w is string => typeof w === 'string')
      : []
    return { count, words: words.slice(0, MAX_TRACKED_WORDS) }
  } catch {
    return emptyManualEdits()
  }
}

export function serializeManualEdits(m: ManualEdits): string {
  return JSON.stringify({ count: m.count, words: m.words })
}

/** Record `n` edited word occurrences of `bareWord` (unique words kept, capped). */
export function addManualEdit(m: ManualEdits, n: number, bareWord: string): ManualEdits {
  if (n <= 0) return m
  const words = m.words.includes(bareWord)
    ? m.words
    : [...m.words, bareWord].slice(-MAX_TRACKED_WORDS)
  return { count: m.count + n, words }
}
