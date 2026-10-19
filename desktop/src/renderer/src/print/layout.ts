/**
 * Print pagination, pure and unit-tested. The document flows as a list of blocks (paragraphs,
 * tables…) with measured positions; pages are windows [start, end) over that flow. Breaks fall
 * between blocks, or inside a plain paragraph on a line boundary. Because we cut the pages
 * ourselves, every page gets the same header and «صفحة ١ من ٥» in Arabic-Indic digits, and the
 * preview shows exactly what prints.
 */
export interface Block {
  /** top of the block including its top margin, px from the start of the flow */
  top: number
  /** bottom including its bottom margin */
  bottom: number
  /** line height when the block is a plain text paragraph that may split across pages */
  lineHeight: number | null
}
export interface PageWindow {
  start: number
  end: number
}

/** Pages needed for `blocks`, each `pageHeight` px tall (always at least one page). */
export function paginate(blocks: Block[], pageHeight: number): PageWindow[] {
  const flowEnd = blocks.reduce((m, b) => Math.max(m, b.bottom), 0)
  const pages: PageWindow[] = []
  let start = blocks.length ? Math.min(blocks[0].top, 0) : 0
  let guard = 0
  while (start < flowEnd - 0.5 && guard++ < 10_000) {
    const limit = start + pageHeight
    let end = limit
    if (flowEnd <= limit + 0.5) {
      pages.push({ start, end: flowEnd })
      return pages
    }
    // the first block that does not fit entirely on this page
    const cut = blocks.find((b) => b.bottom > limit + 0.5 && b.top < limit)
    if (cut) {
      const lh = cut.lineHeight
      if (lh && lh > 0 && cut.bottom - cut.top > lh * 2 && limit - cut.top >= lh) {
        end = cut.top + Math.floor((limit - cut.top) / lh) * lh // last whole line that fits
      } else if (cut.top > start + 0.5) {
        end = cut.top // move the whole block to the next page
      }
      // else: a block taller than a page that starts at the top: cut it at the page edge
    }
    pages.push({ start, end })
    start = end
  }
  return pages.length ? pages : [{ start: 0, end: pageHeight }]
}
