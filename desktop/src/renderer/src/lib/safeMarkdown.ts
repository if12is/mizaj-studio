/**
 * Tiny, strict markdown to HTML for Gemini answers. Everything is HTML-escaped FIRST, so no raw
 * HTML can pass through; only a fixed set of tags we generate ourselves is produced. Links are never
 * made clickable: `[label](url)` is shown as plain text "label (url)".
 */
const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c])

function inline(raw: string): string {
  let s = esc(raw)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,؛،:]|$)/g, '$1<em>$2</em>')
  return s
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }
  const closeList = (): void => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const line of lines) {
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      closeList()
      const lvl = Math.min(6, h[1].length + 2) // keep headings small inside a side panel
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`)
    } else if (ul || ol) {
      flushPara()
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`)
    } else if (!line.trim()) {
      flushPara()
      closeList()
    } else {
      closeList()
      para.push(line)
    }
  }
  flushPara()
  closeList()
  return out.join('')
}
