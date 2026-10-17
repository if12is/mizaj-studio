/**
 * Explicit, user-accepted soft split of very long paragraphs (7.2.4).
 * The display itself copes with long lines; what freezes is applying/undoing
 * tens of thousands of edits inside one gigantic CodeMirror line. Splitting
 * after sentence punctuation (space -> newline) keeps lines short.
 */
export const LONG_LINE_THRESHOLD = 5000
const SENTENCE_END = /[.!?؟؛…:؛]/
const FALLBACK_STEP = 1500

export interface SplitEdit {
  from: number
  to: number
  insert: string
}

/** Longest line length in characters (UTF-16). */
export function longestLine(lines: Iterable<string>): number {
  let m = 0
  for (const l of lines) if (l.length > m) m = l.length
  return m
}

/**
 * Edits turning the space after a sentence-ending mark into a newline inside every line
 * longer than `threshold`. `lines` are given with their absolute start offsets.
 * Lines without usable punctuation are split at the first space after every ~1500 chars.
 */
export function splitLongLineEdits(
  lines: Iterable<{ from: number; text: string }>,
  threshold = LONG_LINE_THRESHOLD
): { edits: SplitEdit[]; lines: number } {
  const edits: SplitEdit[] = []
  let affected = 0
  for (const line of lines) {
    if (line.text.length <= threshold) continue
    affected++
    const t = line.text
    let since = 0
    let last = -1
    for (let i = 0; i < t.length - 1; i++) {
      if (t[i] === ' ' && i > 0 && SENTENCE_END.test(t[i - 1]) && i - last > 20) {
        edits.push({ from: line.from + i, to: line.from + i + 1, insert: '\n' })
        last = i
        since = i
      } else if (t[i] === ' ' && i - since > FALLBACK_STEP) {
        edits.push({ from: line.from + i, to: line.from + i + 1, insert: '\n' })
        last = i
        since = i
      }
    }
  }
  return { edits, lines: affected }
}
