import type { TextEdit } from '../../src/main/systemwide/textDiff'

/**
 * Pure edit planning for Word: turns the minimal text edits of ONE paragraph into operations on
 * single-character ranges, so that every untouched character keeps its run formatting and every
 * touched one keeps the formatting of the character it belongs to.
 *
 *   edit [s,e) -> t   becomes, per character index:
 *     - characters s..e-1 are replaced pairwise (t[i] for index s+i); surplus old characters are
 *       deleted; surplus new characters are appended to the LAST replaced character;
 *     - a pure insertion (s == e) is attached AFTER the character s-1 (the base letter a mark
 *       belongs to, so marks inherit that letter's run), or BEFORE character 0 at the paragraph start.
 *   Several edits touching the same character are merged into one operation per character, which
 *   is applied from the end of the paragraph backwards.
 */

export type CharOp =
  | { index: number; kind: 'replace'; text: string }
  | { index: number; kind: 'delete' }
  | { index: number; kind: 'after'; text: string }
  | { index: number; kind: 'before'; text: string }

interface Slot {
  before: string
  after: string
  /** undefined: keep the character; '' : delete it; otherwise its replacement */
  replace?: string
}

/**
 * Operations for one paragraph, sorted by descending index. Returns null when an edit cannot be
 * anchored (out of range, or an insertion into an empty paragraph).
 */
export function planParagraph(text: string, edits: readonly TextEdit[]): CharOp[] | null {
  const slots = new Map<number, Slot>()
  const slot = (i: number): Slot => {
    let s = slots.get(i)
    if (!s) {
      s = { before: '', after: '' }
      slots.set(i, s)
    }
    return s
  }
  let prevEnd = 0
  for (const e of edits) {
    if (e.start < prevEnd || e.end < e.start || e.end > text.length) return null
    prevEnd = e.end
    // a lone surrogate half would corrupt the text: such edits are never mapped per character
    if (/[\ud800-\udfff]/.test(e.insert)) return null
    const del = e.end - e.start
    if (del === 0) {
      if (e.insert === '') continue
      if (e.start > 0) slot(e.start - 1).after += e.insert
      else if (text.length > 0) slot(0).before += e.insert
      else return null
      continue
    }
    const common = Math.min(del, e.insert.length)
    for (let k = 0; k < common; k++) {
      // the last replaced character also receives the surplus of the new text
      const isLast = k === common - 1
      slot(e.start + k).replace = isLast ? e.insert.slice(k) : e.insert[k]
    }
    for (let k = common; k < del; k++) slot(e.start + k).replace = ''
  }
  const ops: CharOp[] = []
  for (const [index, s] of slots) {
    const orig = text[index]
    if (s.replace === undefined) {
      if (s.before) ops.push({ index, kind: 'before', text: s.before })
      if (s.after) ops.push({ index, kind: 'after', text: s.after })
      continue
    }
    const body = s.before + s.replace + s.after
    if (body === orig) continue
    if (body === '') ops.push({ index, kind: 'delete' })
    else ops.push({ index, kind: 'replace', text: body })
  }
  // before/after on the same untouched character: two ops, "after" first (the range grows at the end)
  ops.sort((a, b) => b.index - a.index || (a.kind === 'after' ? -1 : 1))
  return ops
}

/** Text of a paragraph after the ops (what Word must contain afterwards). */
export function applyOps(text: string, ops: readonly CharOp[]): string {
  const chars = [...text.split('')]
  for (const op of ops) {
    if (op.kind === 'replace') chars[op.index] = op.text
    else if (op.kind === 'delete') chars[op.index] = ''
    else if (op.kind === 'after') chars[op.index] = chars[op.index] + op.text
    else chars[op.index] = op.text + chars[op.index]
  }
  return chars.join('')
}

export type SkipReason = 'field' | 'content_control' | 'special' | 'empty'

/** Field markers, object anchors and other control characters that must not be edited around. */
// eslint-disable-next-line no-control-regex
const SPECIAL_RE = /[\u0013\u0014\u0015\u0002\u0003\u0005\u0007\u0008]/

export function classifyParagraph(p: {
  text: string
  fields: number
  contentControls: number
}): SkipReason | null {
  if (!/\S/.test(p.text)) return 'empty'
  if (p.fields > 0) return 'field'
  if (p.contentControls > 0) return 'content_control'
  if (SPECIAL_RE.test(p.text)) return 'special'
  return null
}

export const SKIP_REASON_AR: Record<SkipReason, string> = {
  empty: 'فقرة فارغة',
  field: 'فقرة تحتوي حقولاً (أرقام صفحات، فهارس، روابط، مراجع…)',
  content_control: 'فقرة تحتوي عناصر تحكم بالمحتوى',
  special: 'فقرة تحتوي عناصر خاصة'
}

/** Whether the characters Word returned for a paragraph are exactly its text, one range per UTF-16 unit. */
export function charsMatch(text: string, chars: readonly string[]): boolean {
  if (chars.length !== text.length) return false
  for (let i = 0; i < text.length; i++) if (chars[i] !== text[i]) return false
  return true
}
