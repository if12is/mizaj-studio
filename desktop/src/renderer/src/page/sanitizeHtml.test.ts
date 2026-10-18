import { describe, expect, it } from 'vitest'
import { cleanStyle, sanitizePageHtml } from './sanitizeHtml'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('sanitizePageHtml', () => {
  it('keeps formatting markup the backend emits', () => {
    const h =
      `<div class="dp-page" dir="rtl" style="width:595pt"><p dir="rtl" style="text-align:center">` +
      `<span style="font-weight:700;text-decoration-line:underline" lang="ar">نص</span></p>` +
      `<img src="${PNG}" alt="شعار" style="width:90pt"><table><tr><td colspan="2" style="border-top:1pt solid #000">x</td></tr></table></div>`
    const out = sanitizePageHtml(h)
    expect(out).toContain('text-align:center')
    expect(out).toContain('font-weight:700')
    expect(out).toContain(`src="${PNG}"`)
    expect(out).toContain('colspan="2"')
    expect(out).toContain('class="dp-page"')
  })

  it('drops scripts, handlers, links, iframes and foreign classes', () => {
    const out = sanitizePageHtml(
      '<script>alert(1)</script><p onclick="x()" class="evil dp-num" id="a">hi<a href="javascript:1">l</a></p>' +
        '<iframe src="x">y</iframe><style>p{}</style><svg onload=1><circle/></svg>'
    )
    expect(out).toBe('<p class="dp-num">hil</p>')
  })

  it('rejects non-data or non-image img sources', () => {
    expect(sanitizePageHtml('<img src="http://evil/x.png">')).toBe('')
    expect(sanitizePageHtml('<img src="data:text/html;base64,AAAA">')).toBe('')
    expect(sanitizePageHtml('<img src="file:///etc/passwd">')).toBe('')
  })

  it('escapes stray markup in text', () => {
    expect(sanitizePageHtml('<p>a < b & c > d</p>')).toBe('<p>a &lt; b &amp; c &gt; d</p>')
  })

  it('closes unbalanced tags', () => {
    expect(sanitizePageHtml('<div><p>x')).toBe('<div><p>x</p></div>')
  })
})

describe('cleanStyle', () => {
  it('whitelists properties and blocks url()/expressions', () => {
    expect(cleanStyle('text-align:center;background:url(http://x);color:#fff')).toBe(
      'text-align:center;color:#fff'
    )
    expect(cleanStyle('width:expression(alert(1))')).toBe('')
    expect(cleanStyle('position:fixed;z-index:9999')).toBe('')
    expect(cleanStyle('position:absolute;z-index:2')).toBe('position:absolute;z-index:2')
    expect(cleanStyle('font-family:"Amiri","Noto Naskh Arabic",serif')).toContain('Amiri')
  })
})
