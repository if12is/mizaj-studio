import { stripMarks } from './arabic'

/**
 * Minimal edit lists between an original text and its processed version.
 *
 * Offsets are UTF-16 code units of the ORIGINAL text (the unit Word's Range and JS strings use).
 * Edits are sorted, non-overlapping and never split a surrogate pair. This list is what the
 * Word/COM path applies (from the end backwards) and what the HTML path maps onto text nodes,
 * so only the characters that really changed are touched and everything else keeps its formatting.
 */
export interface TextEdit {
  start: number
  end: number
  insert: string
}

/** Past this many edit steps a region falls back to one coarse replacement. */
const MAX_D_TOKENS = 2000
const MAX_D_CHARS = 2000

type Op = 'eq' | 'del' | 'ins'

/** Myers O(ND) diff over integer arrays. Returns null when more than maxD edits are needed. */
export function myers(a: number[], b: number[], maxD = 2000): Op[] | null {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  const max = Math.min(n + m, maxD)
  const off = max + 1
  const v = new Int32Array(2 * max + 4)
  // trace[d][k + d + 1] = v[k] at the start of round d, for k in [-d-1, d+1]
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1]
      else x = v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, d)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], a: number[], b: number[], dEnd: number): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length
  for (let d = dEnd; d > 0; d--) {
    const sn = trace[d]
    const at = (k: number): number => sn[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('eq')
      x--
      y--
    }
    if (x === prevX) {
      ops.push('ins')
      y--
    } else {
      ops.push('del')
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push('eq')
    x--
    y--
  }
  return ops.reverse()
}

function internIds(a: string[], b: string[]): [number[], number[]] {
  const ids = new Map<string, number>()
  const id = (s: string): number => {
    let i = ids.get(s)
    if (i === undefined) {
      i = ids.size
      ids.set(s, i)
    }
    return i
  }
  return [a.map(id), b.map(id)]
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/** Edits for one region of two strings at code point granularity; `base` shifts the offsets. */
function charEdits(a: string, b: string, base: number): TextEdit[] {
  if (a === b) return []
  if (a === '') return [{ start: base, end: base, insert: b }]
  if (b === '') return [{ start: base, end: base + a.length, insert: '' }]
  const ca = Array.from(a)
  const cb = Array.from(b)
  const [ia, ib] = internIds(ca, cb)
  const ops = myers(ia, ib, MAX_D_CHARS)
  if (!ops) return [{ start: base, end: base + a.length, insert: b }]
  const edits: TextEdit[] = []
  let pos = base
  let ai = 0
  let bi = 0
  let cur: TextEdit | null = null
  const flush = (): void => {
    if (cur) edits.push(cur)
    cur = null
  }
  for (const op of ops) {
    if (op === 'eq') {
      flush()
      pos += ca[ai].length
      ai++
      bi++
    } else if (op === 'del') {
      cur ??= { start: pos, end: pos, insert: '' }
      cur.end += ca[ai].length
      pos += ca[ai].length
      ai++
    } else {
      cur ??= { start: pos, end: pos, insert: '' }
      cur.insert += cb[bi]
      bi++
    }
  }
  flush()
  return edits
}

function mergeAdjacent(edits: TextEdit[]): TextEdit[] {
  const out: TextEdit[] = []
  for (const e of edits) {
    const last = out[out.length - 1]
    if (last && last.end === e.start) {
      last.end = e.end
      last.insert += e.insert
    } else out.push({ ...e })
  }
  return out
}

/** Minimal sorted, non-overlapping edits turning `a` into `b`. */
export function diffText(a: string, b: string): TextEdit[] {
  if (a === b) return []
  // common prefix / suffix, never splitting a surrogate pair
  const lim = Math.min(a.length, b.length)
  let p = 0
  while (p < lim && a.charCodeAt(p) === b.charCodeAt(p)) p++
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--
  let s = 0
  while (s < lim - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--
  const ma = a.slice(p, a.length - s)
  const mb = b.slice(p, b.length - s)
  if (ma === '' || mb === '') return charEdits(ma, mb, p)

  // Words first (cheap), compared by a "skeleton" (no marks, folded letter variants, no punctuation),
  // so tashkeel / hamza / punctuation changes keep the words aligned and the step count tiny even for
  // very long texts. Characters are then diffed only inside the words that differ.
  const ta = ma.match(/\s+|\S+/gu) ?? []
  const tb = mb.match(/\s+|\S+/gu) ?? []
  const [ia, ib] = internIds(ta.map(skeleton), tb.map(skeleton))
  const ops = myers(ia, ib, MAX_D_TOKENS)
  if (!ops) return mergeAdjacent(charEdits(ma, mb, p))

  const out: TextEdit[] = []
  let aPos = 0
  let bPos = 0
  let ai = 0
  let bi = 0
  let gapA = 0
  let gapB = 0
  const flushGap = (): void => {
    if (gapA !== aPos || gapB !== bPos)
      out.push(...charEdits(ma.slice(gapA, aPos), mb.slice(gapB, bPos), p + gapA))
  }
  for (const op of ops) {
    if (op === 'eq') {
      flushGap()
      if (ta[ai] !== tb[bi]) out.push(...charEdits(ta[ai], tb[bi], p + aPos))
      aPos += ta[ai].length
      bPos += tb[bi].length
      ai++
      bi++
      gapA = aPos
      gapB = bPos
    } else if (op === 'del') {
      aPos += ta[ai].length
      ai++
    } else {
      bPos += tb[bi].length
      bi++
    }
  }
  flushGap()
  return mergeAdjacent(out)
}

/** Word identity for alignment: ignores marks, hamza/ya/alef-maqsura variants, tatweel and punctuation. */
function skeleton(tok: string): string {
  if (/^\s/.test(tok)) return ' '
  const k = tok
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/[\u0649\u06CC]/g, '\u064A')
    .replace(/[^\p{L}\p{N}]/gu, '')
  return k === '' ? tok : k // pure punctuation tokens keep their identity
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = ''
  let pos = 0
  for (const e of edits) {
    out += text.slice(pos, e.start) + e.insert
    pos = e.end
  }
  return out + text.slice(pos)
}

export interface PreviewSegment {
  kind: 'same' | 'change'
  /** the text in the result (for `change`: the whole new word) */
  text: string
  /** `change` only: the original word */
  old?: string
  /** `change` only: base letters changed (not just marks) */
  letters?: boolean
}

/** Word-level preview segments: unchanged text, and changed words with old and new forms. */
export function previewSegments(a: string, b: string): PreviewSegment[] {
  const edits = diffText(a, b)
  if (!edits.length) return a ? [{ kind: 'same', text: a }] : []
  const isWs = (c: string): boolean => /\s/.test(c)
  // widen every edit to whole words of the original, merging overlaps
  const spans: { s: number; e: number; first: number; last: number }[] = []
  edits.forEach((ed, i) => {
    let s = ed.start
    let e = ed.end
    while (s > 0 && !isWs(a[s - 1])) s--
    while (e < a.length && !isWs(a[e])) e++
    const prev = spans[spans.length - 1]
    if (prev && s <= prev.e) {
      prev.e = Math.max(prev.e, e)
      prev.last = i
    } else spans.push({ s, e, first: i, last: i })
  })
  const out: PreviewSegment[] = []
  let pos = 0
  for (const sp of spans) {
    if (sp.s > pos) out.push({ kind: 'same', text: a.slice(pos, sp.s) })
    let res = ''
    let p = sp.s
    for (let i = sp.first; i <= sp.last; i++) {
      res += a.slice(p, edits[i].start) + edits[i].insert
      p = edits[i].end
    }
    res += a.slice(p, sp.e)
    const old = a.slice(sp.s, sp.e)
    out.push({ kind: 'change', text: res, old, letters: stripMarks(old) !== stripMarks(res) })
    pos = sp.e
  }
  if (pos < a.length) out.push({ kind: 'same', text: a.slice(pos) })
  return out
}
