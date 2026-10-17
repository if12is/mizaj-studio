import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'

/**
 * Replace [from,to) with `insert` as ONE transaction, but only if the range still
 * contains exactly `expected` (the text the suggestion was computed for). Returns
 * null when the document changed underneath, so a stale suggestion never edits text.
 */
export function safeEditSpec(
  state: EditorState,
  from: number,
  to: number,
  expected: string,
  insert: string,
  userEvent: string
): TransactionSpec | null {
  if (from < 0 || to < from || to > state.doc.length) return null
  if (state.doc.sliceString(from, to) !== expected) return null
  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    userEvent,
    annotations: [isolateHistory.of('full')]
  }
}

/** Insert text at the cursor (replacing the selection) as one transaction. */
export function insertAtCursorSpec(
  state: EditorState,
  text: string,
  userEvent: string
): TransactionSpec {
  const r = state.selection.main
  return {
    changes: { from: r.from, to: r.to, insert: text },
    selection: EditorSelection.cursor(r.from + text.length),
    userEvent,
    scrollIntoView: true,
    annotations: [isolateHistory.of('full')]
  }
}

export interface VerifiedEdit {
  from: number
  to: number
  expected: string
  insert: string
}

/**
 * Many edits as ONE transaction (one undo step). All-or-nothing: every range must still hold
 * its `expected` text and ranges must not overlap; otherwise null (nothing is changed).
 */
export function safeEditsSpec(
  state: EditorState,
  edits: VerifiedEdit[],
  userEvent: string
): TransactionSpec | null {
  if (!edits.length) return null
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to)
  let prevEnd = -1
  for (const e of sorted) {
    if (e.from < 0 || e.to < e.from || e.to > state.doc.length || e.from < prevEnd) return null
    if (state.doc.sliceString(e.from, e.to) !== e.expected) return null
    prevEnd = e.to
  }
  return {
    changes: sorted.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
    userEvent,
    scrollIntoView: false,
    annotations: [isolateHistory.of('full')]
  }
}
