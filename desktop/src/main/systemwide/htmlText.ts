import type { TextEdit } from './textDiff'

/**
 * Text-node-only transform of an HTML fragment (the clipboard path of the system-wide feature).
 *
 * The HTML is tokenised once. Every token that is not visible text (tags with all their attributes,
 * comments, conditional comments, <style>/<script>/<head> content) is kept byte for byte. The text
 * nodes are decoded, concatenated (with a virtual newline wherever a block element or <br> separates
 * two nodes, so the processor sees paragraphs as paragraphs and a word split across inline runs as
 * one word), processed ONCE, and the result is mapped back onto the nodes by a minimal edit list.
 * Entities in untouched text keep their original spelling.
 */

/** One decoded character of a text node together with the raw source it came from. */
interface Unit {
  raw: string
  text: string
}

type Token =
  | { kind: 'raw'; raw: string }
  | { kind: 'text'; units: Unit[]; start: number; end: number }

export interface HtmlTextDoc {
  /** the processed region as tokens */
  tokens: Token[]
  /** the visible text (what the processor receives) */
  text: string
  /** html before / after the processed region (CF_HTML context), kept as is */
  pre: string
  post: string
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rlm: '‏',
  lrm: '‎',
  zwj: '‍',
  zwnj: '‌',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  shy: '­',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' '
}
/** Stands in for an entity we cannot decode; keeps offsets consistent and is never edited away silently. */
const OPAQUE = '￼'

const SKIP_ELEMENTS = new Set([
  'head',
  'title',
  'script',
  'style',
  'xml',
  'noscript',
  'template',
  'svg',
  'math'
])
const RAW_TEXT_ELEMENTS = new Set(['script', 'style'])
const BLOCK_ELEMENTS = new Set([
  'p',
  'div',
  'br',
  'li',
  'ul',
  'ol',
  'tr',
  'td',
  'th',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'caption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'hr',
  'section',
  'article',
  'header',
  'footer',
  'dl',
  'dt',
  'dd',
  'center',
  'address',
  'form',
  'fieldset',
  'figure',
  'figcaption',
  'body',
  'html'
])

function decodeUnits(raw: string): Unit[] {
  const units: Unit[] = []
  const re = /&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/y
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '&') {
      re.lastIndex = i
      const m = re.exec(raw)
      if (m) {
        const body = m[1]
        let text: string
        if (body[0] === '#') {
          const cp =
            body[1] === 'x' || body[1] === 'X'
              ? parseInt(body.slice(2), 16)
              : parseInt(body.slice(1), 10)
          text =
            cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
              ? String.fromCodePoint(cp)
              : OPAQUE
        } else text = NAMED[body] ?? OPAQUE
        units.push({ raw: m[0], text })
        i += m[0].length
        continue
      }
    }
    const cp = raw.codePointAt(i) as number
    const ch = String.fromCodePoint(cp)
    units.push({ raw: ch, text: ch })
    i += ch.length
  }
  return units
}

export function encodeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\u00a0')
    .join('&nbsp;')
}

const tagStart = /<[A-Za-z/!?]/g

/** Find the end of a tag starting at `i` (index of '<'), honouring quoted attribute values. */
function tagEnd(html: string, i: number): number {
  let q = ''
  for (let j = i + 1; j < html.length; j++) {
    const c = html[j]
    if (q) {
      if (c === q) q = ''
    } else if (c === '"' || c === "'") q = c
    else if (c === '>') return j + 1
  }
  return -1
}

/** Split the region into raw tokens and text tokens (computing the visible text). */
function tokenize(region: string): { tokens: Token[]; text: string } {
  const tokens: Token[] = []
  let text = ''
  let skip = 0
  let sawText = false
  let pendingSep = false
  const pushRaw = (raw: string): void => {
    const last = tokens[tokens.length - 1]
    if (last && last.kind === 'raw') last.raw += raw
    else tokens.push({ kind: 'raw', raw })
  }
  let i = 0
  while (i < region.length) {
    if (region[i] === '<') {
      if (region.startsWith('<!--', i)) {
        const e = region.indexOf('-->', i + 4)
        const end = e < 0 ? region.length : e + 3
        pushRaw(region.slice(i, end))
        i = end
        continue
      }
      const next = region[i + 1]
      if (next !== undefined && /[A-Za-z/!?]/.test(next)) {
        const end = tagEnd(region, i)
        if (end < 0) {
          pushRaw(region.slice(i))
          i = region.length
          continue
        }
        const tag = region.slice(i, end)
        const m = /^<(\/?)([A-Za-z][\w:.-]*)/.exec(tag)
        if (m) {
          const closing = m[1] === '/'
          const name = m[2].toLowerCase()
          const selfClosed = tag.endsWith('/>')
          if (BLOCK_ELEMENTS.has(name)) pendingSep = true
          if (SKIP_ELEMENTS.has(name) && !selfClosed) {
            if (closing) skip = Math.max(0, skip - 1)
            else skip++
          }
          pushRaw(tag)
          i = end
          if (!closing && RAW_TEXT_ELEMENTS.has(name) && !selfClosed) {
            const close = new RegExp(`</${name}\\s*>`, 'ig')
            close.lastIndex = i
            const cm = close.exec(region)
            const stop = cm ? cm.index : region.length
            pushRaw(region.slice(i, stop))
            i = stop
          }
          continue
        }
        pushRaw(tag)
        i = end
        continue
      }
    }
    // text up to the next tag start
    tagStart.lastIndex = i + 1
    const nm = tagStart.exec(region)
    const stop = nm ? nm.index : region.length
    const raw = region.slice(i, stop)
    i = stop
    if (skip > 0) {
      pushRaw(raw)
      continue
    }
    const units = decodeUnits(raw)
    const dec = units.map((u) => u.text).join('')
    const visible = /\S/.test(dec)
    if (visible && pendingSep && sawText) text += '\n'
    if (visible) pendingSep = false
    if (visible) sawText = true
    const start = text.length
    text += dec
    tokens.push({ kind: 'text', units, start, end: text.length })
    // a virtual separator is NOT part of any node; `start` of the next node accounts for it
  }
  return { tokens, text }
}

/** CF_HTML fragment markers. */
const START_MARK = '<!--StartFragment-->'
const END_MARK = '<!--EndFragment-->'

/** Parse the HTML (a clipboard payload or any fragment). Only the fragment region is processed. */
export function parseHtml(html: string): HtmlTextDoc {
  let pre = ''
  let post = ''
  let region = html
  const s = html.indexOf(START_MARK)
  const e = s >= 0 ? html.indexOf(END_MARK, s + START_MARK.length) : -1
  if (s >= 0 && e >= 0) {
    pre = html.slice(0, s + START_MARK.length)
    region = html.slice(s + START_MARK.length, e)
    post = html.slice(e)
  } else {
    const b = /<body[^>]*>/i.exec(html)
    if (b) {
      const from = b.index + b[0].length
      const to = html.toLowerCase().lastIndexOf('</body')
      pre = html.slice(0, from)
      region = to >= from ? html.slice(from, to) : html.slice(from)
      post = to >= from ? html.slice(to) : ''
    }
  }
  const { tokens, text } = tokenize(region)
  return { tokens, text, pre, post }
}

/** Rebuild the HTML after applying `edits` (offsets into `doc.text`). Untouched text is kept raw. */
export function applyEditsToHtml(doc: HtmlTextDoc, edits: readonly TextEdit[]): string {
  const nodes = doc.tokens.filter((t): t is Extract<Token, { kind: 'text' }> => t.kind === 'text')
  type Local = { s: number; e: number; ins: string }
  const perNode = new Map<Token, Local[]>()
  const add = (n: Token, l: Local): void => {
    const arr = perNode.get(n) ?? []
    arr.push(l)
    perNode.set(n, arr)
  }
  for (const ed of edits) {
    if (ed.start === ed.end) {
      // pure insertion: after the character before it (formatting follows the previous character)
      const n =
        nodes.find((x) => x.start < ed.start && ed.start <= x.end) ??
        nodes.find((x) => x.start === ed.start && x.end > x.start)
      if (n && ed.insert) add(n, { s: ed.start - n.start, e: ed.start - n.start, ins: ed.insert })
      continue
    }
    let placed = false
    for (const n of nodes) {
      const s = Math.max(ed.start, n.start)
      const e = Math.min(ed.end, n.end)
      if (s >= e) continue
      // the replacement text goes with the first node the deletion touches
      add(n, { s: s - n.start, e: e - n.start, ins: placed ? '' : ed.insert })
      placed = true
    }
    // an edit lying entirely on virtual separators cannot be expressed in HTML: dropped
  }
  let out = ''
  for (const t of doc.tokens) {
    if (t.kind === 'raw') {
      out += t.raw
      continue
    }
    const locals = perNode.get(t)
    if (!locals) {
      for (const u of t.units) out += u.raw
      continue
    }
    locals.sort((a, b) => a.s - b.s || a.e - b.e)
    let pos = 0
    let li = 0
    for (const u of t.units) {
      // insertions located before this unit
      while (li < locals.length && locals[li].s <= pos) {
        if (locals[li].ins) out += encodeText(locals[li].ins)
        li++
      }
      const del = locals.some((l) => l.s <= pos && pos < l.e && l.e > l.s)
      if (!del) out += u.raw
      pos += u.text.length
    }
    while (li < locals.length) {
      if (locals[li].ins) out += encodeText(locals[li].ins)
      li++
    }
  }
  return doc.pre + out + doc.post
}

// ---------------------------------------------------------------- CF_HTML ("HTML Format")

export interface CfHtml {
  /** the HTML payload (from StartHTML, without the header and the trailing NUL) */
  html: string
  /** header lines other than the four offsets (e.g. SourceURL) */
  extra: string[]
}

/** Decode a CF_HTML buffer (UTF-8). Tolerates a missing or wrong header. */
export function parseCfHtml(buf: Buffer): CfHtml {
  let end = buf.length
  while (end > 0 && buf[end - 1] === 0) end--
  const all = buf.subarray(0, end)
  const headEnd = all.indexOf('<')
  const header = all.subarray(0, headEnd < 0 ? 0 : headEnd).toString('latin1')
  const get = (k: string): number => {
    const m = new RegExp(`${k}:(\\d+)`).exec(header)
    return m ? parseInt(m[1], 10) : -1
  }
  const startHtml = get('StartHTML')
  const endHtml = get('EndHTML')
  const extra = header
    .split(/\r?\n/)
    .filter(
      (l) =>
        /^[A-Za-z]+:/.test(l) && !/^(Version|StartHTML|EndHTML|StartFragment|EndFragment):/.test(l)
    )
  if (startHtml >= 0 && startHtml < all.length) {
    const stop = endHtml > startHtml && endHtml <= all.length ? endHtml : all.length
    return { html: all.subarray(startHtml, stop).toString('utf8'), extra }
  }
  return { html: all.toString('utf8'), extra }
}

/** Build a CF_HTML buffer (with a recomputed, byte-accurate header) for the given HTML. */
export function buildCfHtml(html: string, extra: string[] = []): Buffer {
  let h = html
  if (!h.includes(START_MARK) || !h.includes(END_MARK)) {
    const b = /<body[^>]*>/i.exec(h)
    if (b) {
      const from = b.index + b[0].length
      const to = h.toLowerCase().lastIndexOf('</body')
      const cut = to >= from ? to : h.length
      h = h.slice(0, from) + START_MARK + h.slice(from, cut) + END_MARK + h.slice(cut)
    } else h = `<html><body>${START_MARK}${h}${END_MARK}</body></html>`
  }
  const num = (n: number): string => String(n).padStart(10, '0')
  const lines = (sh: number, eh: number, sf: number, ef: number): string =>
    [
      'Version:0.9',
      `StartHTML:${num(sh)}`,
      `EndHTML:${num(eh)}`,
      `StartFragment:${num(sf)}`,
      `EndFragment:${num(ef)}`,
      ...extra
    ].join('\r\n') + '\r\n'
  const headLen = Buffer.byteLength(lines(0, 0, 0, 0), 'utf8')
  const si = h.indexOf(START_MARK) + START_MARK.length
  const ei = h.indexOf(END_MARK)
  const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')
  const header = lines(
    headLen,
    headLen + bytes(h),
    headLen + bytes(h.slice(0, si)),
    headLen + bytes(h.slice(0, ei))
  )
  return Buffer.from(header + h, 'utf8')
}
