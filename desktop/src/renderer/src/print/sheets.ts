import { pageLabel } from '@renderer/lib/arabicDigits'
import { sanitizePageHtml } from '@renderer/page/sanitizeHtml'
import { paginate, type Block } from './layout'

/** CSS px per point */
export const PX = 96 / 72

export interface CaseData {
  number: string
  court: string
  parties: string
}
export interface PrintOptions {
  title: string
  /** shown in the header of every page when at least one field is filled */
  caseData: CaseData | null
}
export interface PageSize {
  width_pt: number
  height_pt: number
}

/** «رقم القضية: … · المحكمة: … · الأطراف: …» (only the filled fields). */
export function caseLine(c: CaseData | null): string {
  if (!c) return ''
  return [
    c.number.trim() && `رقم القضية: ${c.number.trim()}`,
    c.court.trim() && `المحكمة: ${c.court.trim()}`,
    c.parties.trim() && `الأطراف: ${c.parties.trim()}`
  ]
    .filter(Boolean)
    .join(' · ')
}

const px = (v: string): number => parseFloat(v) || 0

/**
 * Lay the page-view HTML (`/api/docx/render`) out on fixed-size sheets: header (title + case
 * data), the content window, footer «صفحة ١ من ٥». Returns a detached `.print-sheets` element;
 * the preview shows it and the print window receives its HTML.
 */
export async function buildSheets(
  html: string,
  page: PageSize,
  opts: PrintOptions
): Promise<{ root: HTMLElement; pages: number }> {
  const pageW = page.width_pt * PX
  const pageH = page.height_pt * PX
  const probe = document.createElement('div')
  probe.className = 'print-probe'
  probe.setAttribute('aria-hidden', 'true')
  probe.innerHTML = sanitizePageHtml(html)
  document.body.appendChild(probe)
  try {
    try {
      await document.fonts.ready
    } catch {
      /* no font API: measure with what is loaded */
    }
    const src = probe.querySelector<HTMLElement>('.dp-page')
    const root = document.createElement('div')
    root.className = 'print-sheets'
    if (!src) return { root, pages: 0 }
    const cs = getComputedStyle(src)
    const padT = Math.max(px(cs.paddingTop), 64)
    const padB = Math.max(px(cs.paddingBottom), 56)
    const padL = px(cs.paddingLeft)
    const padR = px(cs.paddingRight)
    const contentW = Math.max(120, pageW - padL - padR)
    const windowH = Math.max(120, pageH - padT - padB)
    const dir = src.getAttribute('dir') ?? 'rtl'
    // measure the flow at the content width, without the page frame
    src.classList.add('print-flow')
    src.style.cssText = `width:${contentW}px;min-height:0;padding:0;box-shadow:none;margin:0;position:relative`
    const origin = src.getBoundingClientRect().top
    const blocks = [...src.children].filter(
      (c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains('dp-pageborder')
    )
    const metrics: Block[] = blocks.map((b) => {
      const r = b.getBoundingClientRect()
      const s = getComputedStyle(b)
      const lhRaw = px(s.lineHeight)
      const lh = lhRaw || px(s.fontSize) * 1.4
      const plain = b.tagName === 'P' && !b.querySelector('img,table')
      return {
        top: r.top - origin - px(s.marginTop),
        bottom: r.bottom - origin + px(s.marginBottom),
        lineHeight: plain ? lh : null
      }
    })
    const wins = paginate(metrics, windowH)
    const total = wins.length
    wins.forEach((w, i) => {
      const sheet = document.createElement('section')
      sheet.className = 'print-sheet'
      sheet.dir = dir
      sheet.style.cssText = `width:${pageW}px;height:${pageH}px`
      const head = document.createElement('header')
      head.className = 'print-head'
      head.style.cssText = `padding:0 ${Math.max(padL, 36)}px`
      const t = document.createElement('div')
      t.className = 'print-title'
      t.textContent = opts.title
      head.appendChild(t)
      const line = caseLine(opts.caseData)
      if (line) {
        const c = document.createElement('div')
        c.className = 'print-case'
        c.textContent = line
        head.appendChild(c)
      }
      const win = document.createElement('div')
      win.className = 'print-window'
      win.style.cssText = `top:${padT}px;height:${windowH}px;left:${padL}px;width:${contentW}px`
      blocks.forEach((b, bi) => {
        const m = metrics[bi]
        if (m.bottom <= w.start || m.top >= w.end) return
        const holder = document.createElement('div')
        holder.className = 'dp-page print-block'
        holder.dir = dir
        holder.style.cssText = `position:absolute;left:0;width:${contentW}px;top:${m.top - w.start}px`
        holder.appendChild(b.cloneNode(true))
        win.appendChild(holder)
      })
      const foot = document.createElement('footer')
      foot.className = 'print-foot'
      foot.textContent = pageLabel(i + 1, total)
      foot.dataset.page = String(i + 1)
      sheet.append(head, win, foot)
      root.appendChild(sheet)
    })
    return { root, pages: total }
  } finally {
    probe.remove()
  }
}
