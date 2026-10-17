import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'

/** Typography normalization edits proposed by POST /api/spelling/normalize (7.9.6). */
export interface NormEdit {
  start16: number
  end16: number
  old: string
  new: string
  code: string
  message_ar: string
  severity: string
}

export interface NormResult {
  applied: number
  skipped: number
  spec: TransactionSpec | null
}

/**
 * One transaction applying the selected edits. `base` is where the normalized text started
 * in the document. Each edit is verified against the current text; stale ones are skipped.
 */
export function normalizeSpec(
  state: EditorState,
  base: number,
  edits: NormEdit[],
  selected: Set<number>
): NormResult {
  const changes: { from: number; to: number; insert: string }[] = []
  let skipped = 0
  edits.forEach((e, i) => {
    if (!selected.has(i)) return
    const from = base + e.start16
    const to = base + e.end16
    if (to > state.doc.length || state.doc.sliceString(from, to) !== e.old) {
      skipped++
      return
    }
    changes.push({ from, to, insert: e.new })
  })
  if (!changes.length) return { applied: 0, skipped, spec: null }
  changes.sort((a, b) => a.from - b.from)
  return {
    applied: changes.length,
    skipped,
    spec: {
      changes,
      selection: EditorSelection.cursor(Math.min(state.selection.main.head, state.doc.length)),
      userEvent: 'typography.normalize',
      annotations: [isolateHistory.of('full')]
    }
  }
}
