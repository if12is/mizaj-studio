import { applyOps, type CharOp, type ClusterOp } from './plan'

/**
 * Alignment of the ranges Word returned for `search('?', {matchWildcards:true})` against the
 * paragraph text, tolerant of characters Word does not return (whitespace, tabs, NBSP, direction
 * marks...), plus the mapping of character ops onto those clusters AND onto the gaps between them.
 * Pure functions; no document text ever leaves them except inside the returned ops.
 */

/** Characters Word may skip in a wildcard search: whitespace, control and invisible format marks. */
/* eslint-disable no-control-regex */
const SKIPPABLE_RE = new RegExp(
  '^[\\s\\u0000-\\u001f\\u007f\\u00ad\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]$',
  'u'
)
/* eslint-enable no-control-regex */
const isSkippable = (ch: string): boolean => SKIPPABLE_RE.test(ch)
const isWs = (ch: string): boolean => /^\s$/u.test(ch)

/** Equal, or equal up to which whitespace character it is (Word may normalise NBSP / tabs). */
function sameText(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(isWs(a[i]) && isWs(b[i]))) return false
  return true
}

export const cpOf = (c: string | undefined): string =>
  c === undefined || c === ''
    ? '-'
    : 'U+' + (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')

/** Counts of the code points that are not letters (spaces, tabs, marks, punctuation...), never text. */
export function nonLetterHistogram(s: string): Record<string, number> {
  const h: Record<string, number> = {}
  for (const ch of s) {
    if (/\p{L}/u.test(ch)) continue
    const k = cpOf(ch)
    h[k] = (h[k] ?? 0) + 1
  }
  return h
}

export interface MapFail {
  code: 'map-empty' | 'map-mismatch' | 'map-tail'
  /** paragraph text length */
  len: number
  /** total length of the clusters Word returned, joined */
  got: number
  /** number of clusters */
  n: number
  /** index in the paragraph text where the alignment broke */
  firstDiff: number
  /** code point of the paragraph's character there / of the cluster's first character */
  textCp: string
  clusterCp: string
  textHist: Record<string, number>
  clusterHist: Record<string, number>
}

/** Short technical code for the user: code points and counts only. */
export function failCode(f: MapFail): string {
  return `${f.code} len=${f.len} got=${f.got} n=${f.n} firstDiff=@${f.firstDiff} ${f.textCp}/${f.clusterCp}`
}

export type Alignment =
  | { ok: true; spans: { start: number; end: number }[] }
  | { ok: false; fail: MapFail }

/**
 * Aligns the clusters in order against the text, allowing gaps made only of skippable characters.
 * Every cluster must match the text at its position (whitespace kind aside): nothing is guessed.
 */
export function alignClusters(text: string, clusters: readonly string[]): Alignment {
  const fail = (
    code: MapFail['code'],
    firstDiff: number,
    cluster: string | undefined
  ): Alignment => ({
    ok: false,
    fail: {
      code,
      len: text.length,
      got: clusters.reduce((n, c) => n + c.length, 0),
      n: clusters.length,
      firstDiff,
      textCp: cpOf(text[firstDiff]),
      clusterCp: cpOf(cluster),
      textHist: nonLetterHistogram(text),
      clusterHist: nonLetterHistogram(clusters.join(''))
    }
  })
  if (clusters.length === 0) return fail('map-empty', 0, undefined)
  const spans: { start: number; end: number }[] = []
  let pos = 0
  for (const c of clusters) {
    if (c === '') return fail('map-mismatch', pos, c)
    let at = pos
    while (at < text.length && !sameText(text.slice(at, at + c.length), c) && isSkippable(text[at]))
      at++
    if (at >= text.length || !sameText(text.slice(at, at + c.length), c))
      return fail('map-mismatch', at < text.length ? at : pos, c)
    spans.push({ start: at, end: at + c.length })
    pos = at + c.length
  }
  for (let i = pos; i < text.length; i++)
    if (!isSkippable(text[i])) return fail('map-tail', i, undefined)
  return { ok: true, spans }
}

/** A change confined to characters Word did not return: the text between two clusters. */
export interface GapOp {
  /** the gap lies BEFORE cluster `gap` (clusters.length: after the last one) */
  gap: number
  /** new text of the whole gap ('' deletes it) */
  text: string
}

export interface MappedOps {
  /** from the end of the paragraph backwards */
  gapOps: GapOp[]
  /** from the end of the paragraph backwards */
  clusterOps: ClusterOp[]
}

/**
 * Maps character ops onto the clusters Word returned (a cluster whose new text only grows at its
 * end/start keeps a pure insertion, anything else replaces that one cluster) and onto the gaps
 * between them. Returns the failure description when the clusters cannot be aligned.
 */
export function mapOps(
  text: string,
  clusters: readonly string[],
  ops: readonly CharOp[]
): { ok: true; mapped: MappedOps } | { ok: false; fail: MapFail } {
  const al = alignClusters(text, clusters)
  if (!al.ok) return al
  const byIndex = new Map<number, CharOp[]>()
  for (const op of ops) {
    const l = byIndex.get(op.index)
    if (l) l.push(op)
    else byIndex.set(op.index, [op])
  }
  const rewrite = (a: number, b: number): { changed: boolean; next: string } => {
    let changed = false
    let next = ''
    for (let i = a; i < b; i++) {
      const own = byIndex.get(i)
      if (own) changed = true
      next += applyOps(
        text[i],
        (own ?? []).map((o) => ({ ...o, index: 0 }))
      )
    }
    return { changed, next }
  }
  const gapOps: GapOp[] = []
  const out: ClusterOp[] = []
  let prevEnd = 0
  const gapAt = (g: number, end: number): void => {
    if (end <= prevEnd) return
    const { changed, next } = rewrite(prevEnd, end)
    if (changed && next !== text.slice(prevEnd, end)) gapOps.push({ gap: g, text: next })
  }
  al.spans.forEach((sp, k) => {
    gapAt(k, sp.start)
    const c = text.slice(sp.start, sp.end)
    const { changed, next } = rewrite(sp.start, sp.end)
    prevEnd = sp.end
    if (!changed || next === c) return
    if (next === '') out.push({ index: k, kind: 'delete' })
    else if (next.startsWith(c)) out.push({ index: k, kind: 'after', text: next.slice(c.length) })
    else if (next.endsWith(c))
      out.push({ index: k, kind: 'before', text: next.slice(0, next.length - c.length) })
    else out.push({ index: k, kind: 'replace', text: next })
  })
  gapAt(al.spans.length, text.length)
  return { ok: true, mapped: { gapOps: gapOps.reverse(), clusterOps: out.reverse() } }
}
