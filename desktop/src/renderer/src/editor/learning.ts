import { EditorView } from '@codemirror/view'
import type { ChangeSet, Text } from '@codemirror/state'
import { isMark, stripMarks, wordBoundsAt } from './arabic'
import { applyToAllEdits, type MarkEdit } from './markEdits'

/** A word whose marks (and nothing else) were just changed by the user. */
export interface WordCorrection {
  bare: string
  form: string
  from: number
  to: number
}

const allMarks = (s: string): boolean => [...s].every(isMark)

/**
 * The single word whose diacritics were changed by `changes` (marks-only edits), or null when the
 * change touches base letters, several words, or leaves the word without any mark.
 */
export function markOnlyCorrection(
  oldDoc: Text,
  newDoc: Text,
  changes: ChangeSet
): WordCorrection | null {
  let bad = false
  const words = new Map<number, { from: number; to: number }>()
  changes.iterChanges((fromA, toA, fromB, toB) => {
    if (bad) return
    if (!allMarks(oldDoc.sliceString(fromA, toA)) || !allMarks(newDoc.sliceString(fromB, toB))) {
      bad = true
      return
    }
    // a mark sits right after its letter: look at the letter (fromB - 1) first
    const b = (fromB > 0 && wordBoundsAt(newDoc, fromB - 1)) || wordBoundsAt(newDoc, fromB)
    if (!b) bad = true
    else words.set(b.from, b)
  })
  if (bad || words.size !== 1) return null
  const [w] = [...words.values()]
  const form = newDoc.sliceString(w.from, w.to)
  const bare = stripMarks(form)
  if (bare === form || !bare) return null
  return { bare, form, from: w.from, to: w.to }
}

/** Mark edits turning every OTHER whole-word occurrence of `bare` into `form`. */
export function repeatEdits(
  text: string,
  bare: string,
  form: string,
  skip?: (from: number, to: number) => boolean
): { edits: MarkEdit[]; words: number } {
  const lines: { from: number; text: string }[] = []
  let pos = 0
  for (const t of text.split('\n')) {
    lines.push({ from: pos, text: t })
    pos += t.length + 1
  }
  return applyToAllEdits(lines, bare, form, skip)
}

export interface LearningConfig {
  onWordCorrected(c: WordCorrection): void
}

/** Reports user-made diacritic changes of one word (typed marks or the word inspector). */
export function learningExtension(cfg: LearningConfig) {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return
    const userMade = u.transactions.some(
      (t) =>
        t.isUserEvent('input.type') || t.isUserEvent('delete') || t.isUserEvent('tashkeel.word')
    )
    if (!userMade) return
    const c = markOnlyCorrection(u.startState.doc, u.state.doc, u.changes)
    if (c) cfg.onWordCorrected(c)
  })
}
