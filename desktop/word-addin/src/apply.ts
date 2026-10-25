import { applyEdits as applyTextEdits, type TextEdit } from '../../src/main/systemwide/textDiff'
import { cpOf, mapOps, type MapFail, type MappedOps } from './align'
import { planParagraph, type CharOp } from './plan'
import type { ParaInfo } from './selection'
import type { WContext, WRange } from './types'

/** Total characters that may be enumerated as single-character ranges in one operation. */
export const MAX_ENUMERATED_CHARS = 60_000

export interface ApplyReport {
  /** paragraphs that were edited */
  edited: number
  /** paragraphs with edits that could not be mapped onto characters and were left untouched */
  unmapped: number
  /** paragraphs left untouched because the selection is too large for character mapping */
  tooLarge: number
  /** after writing, a paragraph's text differed from the expected one (the user should press Ctrl+Z) */
  verifyFailed: boolean
  /** why paragraphs could not be mapped (code points and counts only, never text) */
  failures: MapFail[]
  /** verification mismatch (code points and counts only) */
  verifyCodes: string[]
}

interface Job {
  para: ParaInfo
  edits: TextEdit[]
  ops: CharOp[]
  chars: { items: WRange[]; load(p?: string): unknown }
}

/**
 * Writes the per-paragraph edits into Word with the minimal-edit strategy:
 *
 *  1. every paragraph with edits gets one range per character (`search('?')` with wildcards, which
 *     does not depend on Word's diacritic / hamza matching options), checked against the text we
 *     sent: same count, same characters. A paragraph that fails the check is left UNTOUCHED;
 *  2. all writes are queued and sent in ONE `context.sync()` (the best chance of a single Ctrl+Z),
 *     from the end of each paragraph backwards: `insertText(mark, 'End')` after a letter,
 *     `insertText(letter, 'Replace')` on a letter, `delete()` on a letter. Nothing else is touched,
 *     so run properties (font, size, bold, colour, language...) stay as they were;
 *  3. the paragraphs are read back and compared with the expected text.
 */
export async function applyParagraphEdits(
  ctx: WContext,
  paras: readonly ParaInfo[],
  editsByPara: ReadonlyMap<number, TextEdit[]>
): Promise<ApplyReport> {
  const report: ApplyReport = {
    edited: 0,
    unmapped: 0,
    tooLarge: 0,
    verifyFailed: false,
    failures: [],
    verifyCodes: []
  }
  const jobs: Job[] = []
  let budget = MAX_ENUMERATED_CHARS
  for (const [i, edits] of editsByPara) {
    if (!edits.length) continue
    const para = paras[i]
    const ops = planParagraph(para.text, edits)
    if (!ops) {
      report.unmapped++
      continue
    }
    if (para.text.length > budget) {
      report.tooLarge++
      continue
    }
    budget -= para.text.length
    const chars = para.range.search('?', { matchWildcards: true })
    chars.load('items/text')
    jobs.push({ para, edits, ops, chars })
  }
  if (!jobs.length) return report
  await ctx.sync() // read phase: nothing has been written yet

  // Word returns a letter with its diacritics as one range and may skip spaces / tabs altogether:
  // align the returned clusters with the text, edits on skipped characters go through gap ranges
  const ready: (Job & { mapped: MappedOps })[] = []
  for (const j of jobs) {
    const m = mapOps(
      j.para.text,
      j.chars.items.map((r) => r.text),
      j.ops
    )
    if (m.ok) ready.push({ ...j, mapped: m.mapped })
    else {
      report.unmapped++
      report.failures.push(m.fail)
    }
  }
  if (!ready.length) return report

  // gap ranges are created BEFORE any write, between the neighbouring clusters (or the paragraph
  // edges); they are written first so later cluster writes never change what they cover
  for (const j of ready) {
    const items = j.chars.items
    for (const g of j.mapped.gapOps) {
      const left = g.gap > 0 ? items[g.gap - 1].getRange('After') : j.para.range.getRange('Start')
      const right =
        g.gap < items.length ? items[g.gap].getRange('Before') : j.para.range.getRange('End')
      const gr = left.expandTo(right)
      if (g.text === '') gr.delete()
      else gr.insertText(g.text, 'Replace')
    }
    for (const op of j.mapped.clusterOps) {
      const r = items[op.index]
      if (op.kind === 'replace') r.insertText(op.text, 'Replace')
      else if (op.kind === 'delete') r.delete()
      else if (op.kind === 'after') r.insertText(op.text, 'End')
      else r.insertText(op.text, 'Start')
    }
  }
  await ctx.sync() // the only write batch

  // verification reads the WHOLE paragraph: a range that ends where an insertion happened may or may
  // not have grown to include it, the paragraph always has. Whole-paragraph selections are compared
  // exactly; a partial one by length (the text outside the selection is not ours to compare).
  for (const j of ready) j.para.paragraph.load('text')
  await ctx.sync()
  for (const j of ready) {
    const want = applyTextEdits(j.para.text, j.edits)
    const got = j.para.paragraph.text.replace(/[\r\n]+$/, '')
    const whole = j.para.fullText === j.para.text
    const okLen = got.length === j.para.fullText.length + want.length - j.para.text.length
    if (!okLen || (whole && got !== want)) {
      report.verifyFailed = true
      let d = 0
      while (d < got.length && d < want.length && got[d] === want[d]) d++
      report.verifyCodes.push(
        `verify len=${j.para.text.length} want=${want.length} got=${got.length} firstDiff=@${d} ${cpOf(want[d])}/${cpOf(got[d])}`
      )
    }
  }
  report.edited = ready.length
  return report
}
