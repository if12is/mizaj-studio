/**
 * Strict allowlist sanitizer for the server-rendered page-view HTML (defence in depth: the
 * backend already builds this markup from escaped text and whitelisted CSS). Pure string
 * tokenizer (no DOM needed, so it is unit-testable in node). Output contains only the tags,
 * attributes and CSS properties below; images only as base64 data: URIs; never <script>,
 * <style>, <a>, event handlers, or url()/expression() in CSS.
 */
const TAGS = new Set([
  'div',
  'p',
  'span',
  'br',
  'img',
  'table',
  'colgroup',
  'col',
  'tbody',
  'thead',
  'tr',
  'td',
  'th'
])
const VOID = new Set(['br', 'img', 'col'])
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript'
])
const CLASSES = new Set(['dp-page', 'dp-num', 'dp-pagebreak', 'dp-pageborder'])
const CSS_PROPS = new Set([
  'text-align',
  'text-align-last',
  'text-indent',
  'line-height',
  'direction',
  'color',
  'background-color',
  'width',
  'height',
  'min-height',
  'max-width',
  'box-sizing',
  'inset',
  'left',
  'top',
  'position',
  'float',
  'z-index',
  'pointer-events',
  'vertical-align',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'text-transform',
  'text-decoration-line',
  'text-decoration-style',
  'overflow-wrap',
  'border-collapse',
  'table-layout',
  'margin',
  'margin-top',
  'margin-bottom',
  'margin-inline',
  'margin-inline-start',
  'margin-inline-end',
  'padding',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-inline-start',
  'padding-inline-end',
  'border',
  'border-top',
  'border-bottom',
  'border-left',
  'border-right',
  'border-inline-start',
  'border-inline-end'
])
const BAD_VALUE = /url\s*\(|expression|javascript|@|\\|<|>|\{|\}|;|\/\*|var\s*\(|attr\s*\(/i
const OK_VALUE = /^[\p{L}\p{N}\s.,%#"'()\-+:/]*$/u
const DATA_IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/
const ENTITY_FIX = /&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g
const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-\w:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/y
const ATTR_RE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

export function cleanStyle(style: string): string {
  const out: string[] = []
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':')
    if (i < 1) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const val = decl.slice(i + 1).trim()
    if (!CSS_PROPS.has(prop) || !val || BAD_VALUE.test(val) || !OK_VALUE.test(val)) continue
    if (prop === 'position' && !/^(absolute|relative)$/.test(val)) continue
    if (prop === 'float' && !/^(left|right)$/.test(val)) continue
    if (prop === 'z-index' && !/^[0-5]$/.test(val)) continue
    out.push(`${prop}:${val}`)
  }
  return out.join(';')
}

function cleanAttr(tag: string, name: string, raw: string): string | null {
  const value = raw
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
  switch (name) {
    case 'dir':
      return value === 'rtl' || value === 'ltr' ? value : null
    case 'lang':
      return value === 'ar' ? value : null
    case 'class': {
      const ok = value.split(/\s+/).filter((c) => CLASSES.has(c))
      return ok.length ? ok.join(' ') : null
    }
    case 'colspan':
    case 'rowspan':
      return /^\d{1,3}$/.test(value) ? value : null
    case 'alt':
      return tag === 'img' ? value.slice(0, 200) : null
    case 'src':
      return tag === 'img' && DATA_IMG.test(value) ? value : null
    case 'style':
      return cleanStyle(value) || null
    default:
      return null
  }
}

const escAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escText = (s: string): string => s.replace(ENTITY_FIX, '&amp;').replace(/>/g, '&gt;')

export function sanitizePageHtml(input: string): string {
  const out: string[] = []
  const stack: string[] = []
  const lower = input.toLowerCase()
  let i = 0
  const n = input.length
  while (i < n) {
    const lt = input.indexOf('<', i)
    if (lt === -1) {
      out.push(escText(input.slice(i)))
      break
    }
    if (lt > i) out.push(escText(input.slice(i, lt)))
    TAG_RE.lastIndex = lt
    const m = TAG_RE.exec(input)
    if (!m) {
      out.push('&lt;')
      i = lt + 1
      continue
    }
    i = lt + m[0].length
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (DROP_WITH_CONTENT.has(tag) && !closing) {
      const end = lower.indexOf(`</${tag}`, i)
      if (end === -1) break
      const gt = input.indexOf('>', end)
      i = gt === -1 ? n : gt + 1
      continue
    }
    if (!TAGS.has(tag)) continue // unknown tag: drop the tag itself, keep (escaped) text
    if (closing) {
      const k = stack.lastIndexOf(tag)
      if (k === -1 || VOID.has(tag)) continue
      while (stack.length > k) out.push(`</${stack.pop()}>`)
      continue
    }
    const attrs: string[] = []
    ATTR_RE.lastIndex = 0
    let a: RegExpExecArray | null
    while ((a = ATTR_RE.exec(m[3]))) {
      const name = a[1].toLowerCase()
      const v = cleanAttr(tag, name, a[2] ?? a[3] ?? a[4] ?? '')
      if (v !== null) attrs.push(`${name}="${escAttr(v)}"`)
    }
    if (tag === 'img' && !attrs.some((x) => x.startsWith('src='))) continue
    out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`)
    if (!VOID.has(tag)) stack.push(tag)
  }
  while (stack.length) out.push(`</${stack.pop()}>`)
  return out.join('')
}
