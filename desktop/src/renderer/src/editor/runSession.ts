import { ChangeSet, EditorState, Text, Transaction, type TransactionSpec } from '@codemirror/state'
import type { MarkEdit } from './markEdits'
import { allowQuranChange } from './quran'
import type { ConfWord } from './confidence'
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
  /** low-confidence words (offsets relative to `text`) when requested */
  words?: ConfWord[]
}

export interface RunOptions {
  /** true if [from,to) overlaps protected (Quran) text in the CURRENT document */
  isProtected?: (from: number, to: number) => boolean
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

  /** low-confidence words in current-document coordinates (start/end as u16_*) */
  private conf: ConfWord[] = []

  constructor(
    state: EditorState,
    readonly baseFrom: number,
    readonly sentText: string,
    private readonly opts: RunOptions = {}
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
    const prot = this.opts.isProtected
    if (prot && edits.some((e) => prot(e.from, Math.max(e.to, e.from + 1)))) {
      this.skipped++
      return null
    }
    const origFrom = this.baseFrom + this.toUtf16(chunk.start)
    // One replacement per chunk (not one change per mark): applying tens of thousands of
    // tiny changes inside a huge single line is quadratic in CodeMirror's Text tree.
    // Marks-only edits are still used to map the selection exactly.
    this.origEdits.push({ from: origFrom, to: origFrom + current.length, insert: chunk.text })
    const delta = chunk.text.length - current.length
    this.regions.push({ from: origFrom, to: this.baseFrom + this.toUtf16(chunk.end), delta })
    this.applied++
    for (const c of this.conf) {
      if (c.u16_start >= to) {
        c.u16_start += delta
        c.u16_end += delta
      }
    }
    for (const w of chunk.words ?? [])
      this.conf.push({ ...w, u16_start: from + w.u16_start, u16_end: from + w.u16_end })
    return {
      changes: { from, to, insert: chunk.text },
      selection: mapSelection(state.selection, edits),
      annotations: [Transaction.addToHistory.of(false), allowQuranChange.of(true)]
    }
  }

  /** Map a pre-run position to the current document. */
  mapPos(pos: number): number {
    return this.mapOrig(pos)
  }

  /** Low-confidence words at their final document positions (call after finish()). */
  takeConfidence(): ConfWord[] {
    return this.conf
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
        annotations: [Transaction.addToHistory.of(false), allowQuranChange.of(true)]
      },
      {
        changes,
        selection: state.selection,
        userEvent: 'tashkeel',
        annotations: [isolateHistory.of('full'), allowQuranChange.of(true)]
      }
    ]
  }
}
