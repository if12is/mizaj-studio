/* eslint-disable no-control-regex, no-irregular-whitespace, no-misleading-character-class */
import { EditorView } from '@codemirror/view'
import { insertAtCursorSpec } from './safeEdit'

/** Rich paste from Word/web (7.3.6): HTML clipboard -> clean text. DOM-free so it is unit-testable. */

const ENTITIES: Record<string, string> = {
  nbsp: '\u00A0',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  rlm: '\u200F',
  lrm: '\u200E'
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Invisible direction/format controls Word inserts; they silently flip the text direction. */
const DIRECTION_JUNK = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g

export function cleanText(s: string): string {
  return s
    .replace(DIRECTION_JUNK, '')
    .replace(/[\u00A0\u2007\u202F\u2009\u200A]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

export interface PasteOptions {
  /** true (default): keep paragraph breaks; false: merge all lines into one paragraph */
  keepParagraphs?: boolean
}

/**
 * Convert clipboard HTML to plain text: keeps paragraphs, line breaks, list items and table
 * cells; drops styling, scripts, Word conditional comments and mso markup; keeps diacritics.
 */
export function htmlToPlainText(html: string, o: PasteOptions = {}): string {
  let h = html
  const frag = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(h)
  if (frag) h = frag[1]
  h = h
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '') // Word conditional comments
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|meta|link|xml|o:p)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<o:p\s*\/?>/gi, '')
  h = h
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\u0001') // explicit line break
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|ul|ol|table)\s*>/gi, '\u0002')
    .replace(/<\/(td|th)\s*>/gi, '\u0003')
    .replace(/<li\b[^>]*>/gi, '\u0002• ')
    .replace(/<[^>]+>/g, '')
  h = decode(h)
  // HTML whitespace collapses; our markers carry the structure
  h = h.replace(/[ \t\n\f]+/g, ' ')
  const paras = h
    .split('\u0002')
    .map((p) =>
      p
        .split('\u0001')
        .map((l) =>
          cleanText(l)
            .replace(/ *\u0003 */g, '\t')
            .replace(/\t+$/, '')
            .trim()
        )
        .join('\n')
        .trim()
    )
    .filter((p) => p !== '')
  let out = paras.join('\n').trim()
  if (o.keepParagraphs === false) out = out.replace(/\s*\n\s*/g, ' ')
  return out
}

/** CodeMirror paste handler: only intercepts when the clipboard carries text/html. */
export function richPasteHandler(getKeep: () => boolean) {
  return EditorView.domEventHandlers({
    paste(e, view) {
      const html = e.clipboardData?.getData('text/html')
      if (!html) return false
      const text = htmlToPlainText(html, { keepParagraphs: getKeep() })
      if (!text.trim()) return false
      e.preventDefault()
      view.dispatch(insertAtCursorSpec(view.state, text, 'input.paste'))
      return true
    }
  })
}
