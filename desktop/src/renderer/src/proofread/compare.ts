/**
 * Side-by-side «قبل / بعد» comparison, pure helpers (no DOM, no stores).
 *
 * The original and the result are compared paragraph by paragraph and word by word on the
 * mark-free letters: a word whose letters differ is a PROOFREADING change (amber), a word whose
 * letters are the same but whose marks differ is a DIACRITICS-only change (emerald). Every
 * changed segment knows where it sits in the result text, so reverting one word is one verified
 * edit (`expected` = the result word, `insert` = the original word).
 */

export type SegKind = 'same' | 'proof' | 'diac'

export interface Seg {
  kind: SegKind
  before: string
  after: string
  /** offset of `after` in the whole result text */
  afterFrom: number
  /** false for whole paragraphs that exist on one side only */
  revertable: boolean
}

export interface Row {
  segs: Seg[]
  changed: boolean
}

export interface CompareResult {
  rows: Row[]
  proof: number
  diac: number
}

const MARKS_RE = /[ً-ْ]/g
const TOKEN_RE = /[ء-غـ-ْٰٱ]+|[\s\S]/gu

export const stripMarks = (s: string): string => s.replace(MARKS_RE, '')

export type Op = [
  tag: 'equal' | 'replace' | 'delete' | 'insert',
  i1: number,
  i2: number,
  j1: number,
  j2: number
]

const DP_LIMIT = 4_000_000

/** Opcodes turning `a` into `b` (common prefix/suffix, then LCS; one block for huge middles). */
export function diffSeq(a: readonly string[], b: readonly string[]): Op[] {
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++
  let ea = a.length
  let eb = b.length
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  const ops: Op[] = []
  const push = (tag: Op[0], i1: number, i2: number, j1: number, j2: number): void => {
    if (i1 === i2 && j1 === j2) return
    const last = ops[ops.length - 1]
    if (tag === 'equal' && last && last[0] === 'equal' && last[2] === i1) last[2] = i2
    else ops.push([tag, i1, i2, j1, j2])
  }
  push('equal', 0, lo, 0, lo)
  const n = ea - lo
  const m = eb - lo
  const block = (i1: number, i2: number, j1: number, j2: number): void => {
    if (i1 === i2) push('insert', i1, i2, j1, j2)
    else if (j1 === j2) push('delete', i1, i2, j1, j2)
    else push('replace', i1, i2, j1, j2)
  }
  if (n === 0 || m === 0 || n * m > DP_LIMIT) {
    block(lo, ea, lo, eb)
  } else {
    // LCS table over the middle
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        t[i * w + j] =
          a[lo + i] === b[lo + j]
            ? t[(i + 1) * w + j + 1] + 1
            : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    let i = 0
    let j = 0
    let pi = 0
    let pj = 0 // start of the pending non-equal block
    while (i < n && j < m) {
      if (a[lo + i] === b[lo + j]) {
        if (pi < i || pj < j) block(lo + pi, lo + i, lo + pj, lo + j)
        let k = 0
        while (i + k < n && j + k < m && a[lo + i + k] === b[lo + j + k]) k++
        push('equal', lo + i, lo + i + k, lo + j, lo + j + k)
        i += k
        j += k
        pi = i
        pj = j
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++
      else j++
    }
    block(lo + pi, ea, lo + pj, eb)
  }
  push('equal', ea, a.length, eb, b.length)
  return ops
}

interface Tok {
  text: string
  start: number
}

function tokens(s: string): Tok[] {
  const out: Tok[] = []
  for (const m of s.matchAll(TOKEN_RE)) out.push({ text: m[0], start: m.index ?? 0 })
  return out
}

/** Segments of one paragraph pair. `afterBase` is the offset of `after` in the result text. */
export function compareLine(before: string, after: string, afterBase: number): Seg[] {
  const ot = tokens(before)
  const nt = tokens(after)
  const ops = diffSeq(
    ot.map((t) => stripMarks(t.text)),
    nt.map((t) => stripMarks(t.text))
  )
  const segs: Seg[] = []
  const same = (text: string, from: number): void => {
    const last = segs[segs.length - 1]
    if (last && last.kind === 'same') {
      last.before += text
      last.after += text
    } else
      segs.push({
        kind: 'same',
        before: text,
        after: text,
        afterFrom: afterBase + from,
        revertable: false
      })
  }
  const join = (t: Tok[], a: number, b: number): string =>
    t
      .slice(a, b)
      .map((x) => x.text)
      .join('')
  for (const [tag, i1, i2, j1, j2] of ops) {
    if (tag === 'equal') {
      for (let k = 0; k < i2 - i1; k++) {
        const o = ot[i1 + k]
        const n = nt[j1 + k]
        if (o.text === n.text) same(n.text, n.start)
        else
          segs.push({
            kind: 'diac',
            before: o.text,
            after: n.text,
            afterFrom: afterBase + n.start,
            revertable: true
          })
      }
    } else {
      const from = j1 < nt.length ? nt[j1].start : after.length
      segs.push({
        kind: 'proof',
        before: join(ot, i1, i2),
        after: join(nt, j1, j2),
        afterFrom: afterBase + from,
        revertable: true
      })
    }
  }
  return segs
}

/** Compare the whole texts; paragraphs are paired by position, or aligned when counts differ. */
export function compareTexts(before: string, after: string): CompareResult {
  const bl = before.split('\n')
  const al = after.split('\n')
  const starts: number[] = []
  let pos = 0
  for (const l of al) {
    starts.push(pos)
    pos += l.length + 1
  }
  const rows: Row[] = []
  let proof = 0
  let diac = 0
  const pair = (b: string, a: string, ai: number): void => {
    const segs = compareLine(b, a, starts[ai])
    const changed = segs.some((s) => s.kind !== 'same')
    for (const s of segs) {
      if (s.kind === 'proof') proof++
      else if (s.kind === 'diac') diac++
    }
    rows.push({ segs, changed })
  }
  const lone = (text: string, side: 'before' | 'after', ai: number): void => {
    if (!text.trim()) {
      rows.push({ segs: [], changed: false })
      return
    }
    rows.push({
      segs: [
        {
          kind: 'proof',
          before: side === 'before' ? text : '',
          after: side === 'after' ? text : '',
          afterFrom: starts[Math.min(ai, starts.length - 1)] ?? 0,
          revertable: false
        }
      ],
      changed: true
    })
    proof++
  }
  if (bl.length === al.length) {
    for (let i = 0; i < al.length; i++) pair(bl[i], al[i], i)
  } else {
    const ops = diffSeq(bl.map(stripMarks), al.map(stripMarks))
    for (const [tag, i1, i2, j1, j2] of ops) {
      if (tag === 'equal') for (let k = 0; k < i2 - i1; k++) pair(bl[i1 + k], al[j1 + k], j1 + k)
      else {
        const n = Math.min(i2 - i1, j2 - j1)
        // a replaced block: pair the lines that are still similar by position, rest alone
        for (let k = 0; k < n; k++) pair(bl[i1 + k], al[j1 + k], j1 + k)
        for (let k = n; k < i2 - i1; k++) lone(bl[i1 + k], 'before', j1 + n)
        for (let k = n; k < j2 - j1; k++) lone(al[j1 + k], 'after', j1 + k)
      }
    }
  }
  return { rows, proof, diac }
}
