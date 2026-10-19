import { classifyParagraph, type SkipReason } from './plan'
import type { WContext, WParagraph, WRange } from './types'

/** One paragraph of the selection: only the part inside the selection, as a range. */
export interface ParaInfo {
  /** text of the part of the paragraph inside the selection (no paragraph mark) */
  text: string
  /** why the paragraph is left alone, or null when it can be processed */
  skip: SkipReason | null
  /** inside a table cell (informational: cell paragraphs are edited like any other) */
  inTable: boolean
  range: WRange
  /** the whole Word paragraph (re-read after writing to verify the result) */
  paragraph: WParagraph
  /** text of the whole paragraph, without its paragraph mark */
  fullText: string
}

export interface SelectionRead {
  /** the selection holds no text at all (an insertion point) */
  empty: boolean
  paras: ParaInfo[]
}

/**
 * Reads the selection paragraph by paragraph (two round trips, no writes). Fields and content
 * controls are detected PER PARAGRAPH; such paragraphs are never edited (see classifyParagraph).
 */
export async function readSelection(ctx: WContext): Promise<SelectionRead> {
  const sel = ctx.document.getSelection()
  sel.load('text')
  const paragraphs = sel.paragraphs
  paragraphs.load('items')
  await ctx.sync()
  if (!sel.text) return { empty: true, paras: [] }

  const entries = paragraphs.items.map((p) => {
    p.load('text,tableNestingLevel')
    p.fields.load('items')
    p.contentControls.load('items')
    const range = p.getRange('Content').intersectWith(sel)
    range.load('text')
    return { p, range }
  })
  await ctx.sync()

  const paras: ParaInfo[] = entries.map(({ p, range }) => {
    const text = range.text.replace(/[\r\n]+$/, '')
    return {
      text,
      skip: classifyParagraph({
        text,
        fields: p.fields.items.length,
        contentControls: p.contentControls.items.length
      }),
      inTable: p.tableNestingLevel > 0,
      range,
      paragraph: p,
      fullText: p.text.replace(/[\r\n]+$/, '')
    }
  })
  return { empty: false, paras }
}
