import { ChangeSet, EditorState, Text, Transaction, type TransactionSpec } from '@codemirror/state'
import type { MarkEdit } from './markEdits'
import { isolateHistory } from '@codemirror/commands'
import { stripMarks } from './arabic'
import { diffMarkEdits, mapSelection } from './markEdits'

export interface StreamChunk {
  chunk_id: number
  start: number
  end: number
  text: string
  progress: number
  wps: number
  cached: number
}

/**
 * One diacritization run over [baseFrom, baseTo) of the document.
 *
 * Chunks are applied live as non-history transactions (the editor is
 * read-only during a run). Their composition is kept so that finish()
 * can collapse the whole run into ONE undo step: revert (no history) +
 * re-apply the composite (history, isolated).
 * Chunk offsets are mapped through the changes already applied by the run.
 */
export class RunSession {
  readonly origDoc: Text
  /** Applied chunk regions in ORIGINAL coordinates + length delta (O(1) mapping). */
  private regions: { from: number; to: number; delta: number }[] = []
  /** All edits so far, in original-document coordinates (composed only at finish). */
  private origEdits: MarkEdit[] = []
  private cp: number[] | null = null
  skipped = 0
  applied = 0

  constructor(
    state: EditorState,
    readonly baseFrom: number,
    readonly sentText: string
  ) {
    this.origDoc = state.doc
    // Python offsets are code points; convert when astral characters exist.
    if (/[\uD800-\uDBFF]/.test(sentText)) {
      this.cp = [0]
      for (let i = 0; i < sentText.length; i++) {
        const c = sentText.charCodeAt(i)
        if (c >= 0xdc00 && c <= 0xdfff) continue
        this.cp.push(i + (c >= 0xd800 && c <= 0xdbff ? 2 : 1))
      }
    }
  }

  private toUtf16(n: number): number {
    return this.cp ? this.cp[n] ?? this.sentText.length : n
  }

  /** Map an original position to the current document (chunks entirely before it). */
  private mapOrig(p: number): number {
    let d = 0
    for (const r of this.regions) if (r.to <= p) d += r.delta
    return p + d
  }

  /** Current-document range for a chunk (mapped through earlier run edits). */
  rangeOf(chunk: Pick<StreamChunk, 'start' | 'end'>): { from: number; to: number } {
    return {
      from: this.mapOrig(this.baseFrom + this.toUtf16(chunk.start)),
      to: this.mapOrig(this.baseFrom + this.toUtf16(chunk.end))
    }
  }

  /** Spec to apply a chunk, or null if nothing to do / mismatch (skipped++). */
  applyChunk(state: EditorState, chunk: StreamChunk): TransactionSpec | null {
    const { from, to } = this.rangeOf(chunk)
    if (from < 0 || to > state.doc.length || from > to) {
      this.skipped++
      return null
    }
    const current = state.doc.sliceString(from, to)
    if (stripMarks(current) !== stripMarks(chunk.text)) {
      this.skipped++
      return null
    }
    const edits = diffMarkEdits(current, chunk.text, from)
    if (!edits || edits.length === 0) return null
    const origFrom = this.baseFrom + this.toUtf16(chunk.start)
    const shift = origFrom - from
    let delta = 0
    for (const e of edits) {
      this.origEdits.push({ from: e.from + shift, to: e.to + shift, insert: e.insert })
      delta += e.insert.length - (e.to - e.from)
    }
    this.regions.push({ from: origFrom, to: this.baseFrom + this.toUtf16(chunk.end), delta })
    this.applied++
    return {
      changes: edits,
      selection: mapSelection(state.selection, edits),
      annotations: Transaction.addToHistory.of(false)
    }
  }

  /** Map a pre-run position to the current document. */
  mapPos(pos: number): number {
    return this.mapOrig(pos)
  }

  hasChanges(): boolean {
    return this.origEdits.length > 0
  }

  /** Specs (dispatch in order) that make the whole run a single undo event. */
  finish(state: EditorState): TransactionSpec[] {
    if (!this.origEdits.length) return []
    const sorted = [...this.origEdits].sort((x, y) => x.from - y.from)
    const changes = ChangeSet.of(sorted, this.origDoc.length)
    const inv = changes.invert(this.origDoc)
    return [
      {
        changes: inv,
        selection: state.selection.map(inv),
        annotations: Transaction.addToHistory.of(false)
      },
      {
        changes,
        selection: state.selection,
        userEvent: 'tashkeel',
        annotations: [isolateHistory.of('full')]
      }
    ]
  }
}
