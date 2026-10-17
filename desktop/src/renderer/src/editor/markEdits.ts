import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { isMark, stripMarks, WORD_RE } from './arabic'

/**
 * A "mark edit" replaces the block of combining marks that follows one base
 * character. Because only mark blocks change, the base text and the cursor
 * keep their meaning; positions are mapped by mapPosThroughEdits().
 */
export interface MarkEdit {
  from: number
  to: number
  insert: string
}

function blocks(s: string): { bases: string[]; blocks: string[] } {
  const bases: string[] = []
  const bl: string[] = ['']
  for (const ch of s) {
    if (isMark(ch)) bl[bl.length - 1] += ch
    else {
      bases.push(ch)
      bl.push('')
    }
  }
  return { bases, blocks: bl }
}

/**
 * Minimal mark-block edits turning `oldText` (located at `offset`) into
 * `newText`. Returns null when the base (non-mark) text differs.
 */
export function diffMarkEdits(oldText: string, newText: string, offset: number): MarkEdit[] | null {
  if (stripMarks(oldText) !== stripMarks(newText)) return null
  const a = blocks(oldText)
  const b = blocks(newText)
  const edits: MarkEdit[] = []
  let pos = offset
  for (let i = 0; i < a.blocks.length; i++) {
    const len = a.blocks[i].length
    if (a.blocks[i] !== b.blocks[i]) edits.push({ from: pos, to: pos + len, insert: b.blocks[i] })
    pos += len
    if (i < a.bases.length) pos += a.bases[i].length
  }
  return edits
}

/** Map an old-document position through sorted, non-overlapping mark edits. */
export function mapPosThroughEdits(p: number, edits: MarkEdit[]): number {
  let delta = 0
  for (const e of edits) {
    if (p < e.from) break
    if (p > e.to) {
      delta += e.insert.length - (e.to - e.from)
      continue
    }
    if (e.from === e.to || p === e.to) return e.from + delta + e.insert.length
    if (p === e.from) return e.from + delta
    return e.from + delta + Math.min(p - e.from, e.insert.length)
  }
  return p + delta
}

export function mapSelection(sel: EditorSelection, edits: MarkEdit[]): EditorSelection {
  return EditorSelection.create(
    sel.ranges.map((r) =>
      EditorSelection.range(mapPosThroughEdits(r.anchor, edits), mapPosThroughEdits(r.head, edits))
    ),
    sel.mainIndex
  )
}

/** One transaction (= one undo step) applying the edits, cursor preserved. */
export function editsToSpec(
  state: EditorState,
  edits: MarkEdit[],
  userEvent: string
): TransactionSpec {
  return {
    changes: edits,
    selection: mapSelection(state.selection, edits),
    userEvent,
    annotations: [isolateHistory.of('full')]
  }
}

/** Marks-only edits that strip diacritics from [from, to). */
export function stripEdits(text: string, from: number): MarkEdit[] {
  return diffMarkEdits(text, stripMarks(text), from) ?? []
}

/** All whole-word occurrences with the same bare form -> new diacritized form. */
export function applyToAllEdits(
  lines: Iterable<{ from: number; text: string }>,
  bare: string,
  newForm: string,
  skip?: (from: number, to: number) => boolean
): { edits: MarkEdit[]; words: number } {
  const edits: MarkEdit[] = []
  let words = 0
  for (const line of lines) {
    for (const m of line.text.matchAll(WORD_RE)) {
      if (stripMarks(m[0]) !== bare || m[0] === newForm) continue
      const abs = line.from + (m.index ?? 0)
      if (skip?.(abs, abs + m[0].length)) continue
      const e = diffMarkEdits(m[0], newForm, line.from + (m.index ?? 0))
      if (e && e.length) {
        edits.push(...e)
        words++
      }
    }
  }
  return { edits, words }
}
