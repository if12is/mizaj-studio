import { describe, expect, it } from 'vitest'
import { applyEditsToHtml, buildCfHtml, encodeText, parseCfHtml, parseHtml } from './htmlText'
import { diffText } from './textDiff'

/** Process the visible text with `fn`, map it back, return the new HTML. */
function run(html: string, fn: (t: string) => string): { html: string; text: string } {
  const doc = parseHtml(html)
  const out = fn(doc.text)
  return { html: applyEditsToHtml(doc, diffText(doc.text, out)), text: doc.text }
}

/** HTML with all text removed: tags, attributes, comments must not change. */
const skeleton = (h: string): string => h.replace(/(^|>)[^<]+/g, '$1')

describe('parseHtml: visible text', () => {
  it('extracts text nodes and decodes entities', () => {
    const d = parseHtml('<p>a &amp; b&nbsp;c &lt;d&gt; &#1575; &#x628; &quot;x&quot;</p>')
    expect(d.text).toBe('a & b c <d> ا ب "x"')
  })

  it('skips style, script, head, comments and conditional comments', () => {
    const h =
      '<html><head><title>عنوان</title><style>p{color:red}</style></head><body><!--[if gte mso 9]><xml>سري</xml><![endif]--><script>var a="x<y"</script><p>نص</p></body></html>'
    expect(parseHtml(h).text).toBe('نص')
  })

  it('separates block elements with a newline but not inline runs', () => {
    expect(parseHtml('<p>ا</p><p>ب</p>').text).toBe('ا\nب')
    expect(parseHtml('<p>ا<br>ب</p>').text).toBe('ا\nب')
    expect(parseHtml('<p><span>الك</span><b>تاب</b></p>').text).toBe('الكتاب')
  })

  it('does not create extra separators for whitespace-only nodes', () => {
    expect(parseHtml('<p>ا</p>\n  <p>ب</p>').text).toBe('ا\n  \nب')
  })

  it('treats a lone < as text and handles > inside quoted attributes', () => {
    expect(parseHtml('<p title="a>b">x < y</p>').text).toBe('x < y')
  })

  it('keeps unknown entities as one opaque placeholder', () => {
    expect(parseHtml('<p>a&foobar;b</p>').text).toBe('a￼b')
  })

  it('uses only the CF_HTML fragment when markers exist', () => {
    const h = '<html><body>خارج<!--StartFragment--><p>داخل</p><!--EndFragment-->خارج</body></html>'
    expect(parseHtml(h).text).toBe('داخل')
  })
})

describe('applyEditsToHtml: tags and attributes stay identical', () => {
  const word =
    '<p class=MsoNormal dir=RTL style=\'margin:0cm;text-align:right;mso-bidi-font-family:"Times New Roman"\'><span lang=AR-SA style=\'font-size:14.0pt;color:#C00000;font-family:"Traditional Arabic"\'>كتاب جديد</span><o:p></o:p></p>'

  it('adding diacritics changes only text', () => {
    const r = run(word, () => 'كِتَابٌ جَدِيدٌ')
    expect(r.html).toContain('>كِتَابٌ جَدِيدٌ</span>')
    expect(skeleton(r.html)).toBe(skeleton(word))
  })

  it('identity transform returns the exact input', () => {
    expect(run(word, (t) => t).html).toBe(word)
  })

  it('works across multiple runs with different styles', () => {
    const h = '<p><b style="color:red">كتاب</b> <i>جديد</i> <u>جدا</u></p>'
    const r = run(h, () => 'كِتَابٌ جَدِيدٌ جِدًّا')
    expect(r.html).toBe('<p><b style="color:red">كِتَابٌ</b> <i>جَدِيدٌ</i> <u>جِدًّا</u></p>')
  })

  it('handles a word split across runs: marks follow the preceding letter', () => {
    const h = '<p><span style="a:1">الك</span><span style="b:2">تاب</span></p>'
    const r = run(h, () => 'الْكِتَابُ')
    expect(r.html).toBe('<p><span style="a:1">الْكِ</span><span style="b:2">تَابُ</span></p>')
  })

  it('a replaced letter inside one run keeps the run intact', () => {
    const h = '<p><span style="x:1">قال ابو</span><span style="y:2"> زيد</span></p>'
    const r = run(h, (t) => t.replace('ابو', 'أبو'))
    expect(r.html).toBe('<p><span style="x:1">قال أبو</span><span style="y:2"> زيد</span></p>')
  })

  it('a replacement spanning two runs puts the new text in the first and deletes in the second', () => {
    const h = '<p><span style="x:1">ا</span><span style="y:2">بو</span></p>'
    const r = run(h, () => 'أبو')
    expect(r.html).toBe('<p><span style="x:1">أ</span><span style="y:2">بو</span></p>')
  })

  it('keeps paragraphs apart: an insertion at the end of paragraph 1 stays in paragraph 1', () => {
    const h = '<p class="a">كتاب</p><p class="b">قلم</p>'
    const r = run(h, () => 'كِتَابُ\nقَلَمُ')
    expect(r.html).toBe('<p class="a">كِتَابُ</p><p class="b">قَلَمُ</p>')
  })

  it('processor changing the virtual newline cannot corrupt the structure', () => {
    const h = '<p>ا</p><p>ب</p>'
    const r = run(h, () => 'ا ب')
    expect(skeleton(r.html)).toBe(skeleton(h))
    expect(r.html).toBe(h) // an edit that lies only on the separator is dropped
  })

  it('preserves untouched entities exactly and escapes inserted markup characters', () => {
    const h = '<p>a&nbsp;&amp;&#1575;b &rlm;&#x200F;</p>'
    const r = run(h, (t) => t.replace('b', 'b<>&'))
    expect(r.html).toBe(
      '<p>a&nbsp;&amp;&#1575;b<>& &rlm;&#x200F;</p>'.replace('b<>&', 'b&lt;&gt;&amp;')
    )
  })

  it('keeps RTL/LTR marks and joiners', () => {
    const h = '<p>‏كتاب‎</p>'
    const r = run(h, () => '‏كِتَاب‎')
    expect(r.html).toBe('<p>‏كِتَاب‎</p>')
  })

  it('does not touch style, script or comments', () => {
    const h =
      '<html><head><style>.a{x:1}</style></head><body><!--c--><p>كتاب</p><script>1</script></body></html>'
    const r = run(h, () => 'كِتَاب')
    expect(r.html).toBe(h.replace('كتاب', 'كِتَاب'))
  })

  it('maps a deletion (extra space) inside an entity-rich node', () => {
    const h = '<p>كلي  ،وسهلي&nbsp;x</p>'
    const r = run(h, (t) => t.replace('كلي  ،وسهلي', 'كلي، وسهلي'))
    expect(r.html).toBe('<p>كلي، وسهلي&nbsp;x</p>')
  })

  it('works on tables and lists', () => {
    const h = '<table><tr><td>كتاب</td><td>قلم</td></tr></table><ul><li>باب</li></ul>'
    const r = run(h, () => 'كِتَابٌ\nقَلَمٌ\nبَابٌ')
    expect(r.html).toBe(
      '<table><tr><td>كِتَابٌ</td><td>قَلَمٌ</td></tr></table><ul><li>بَابٌ</li></ul>'
    )
  })

  it('works on a CF_HTML fragment (context kept)', () => {
    const h =
      '<html><body><!--StartFragment--><span style="c:1">كتاب</span><!--EndFragment--></body></html>'
    const r = run(h, () => 'كِتَاب')
    expect(r.html).toBe(
      '<html><body><!--StartFragment--><span style="c:1">كِتَاب</span><!--EndFragment--></body></html>'
    )
  })

  it('handles astral characters in entities and text', () => {
    const h = '<p>&#128512;كتاب😀</p>'
    const r = run(h, (t) => t.replace('كتاب', 'كِتَاب'))
    expect(r.html).toBe('<p>&#128512;كِتَاب😀</p>')
  })
})

describe('encodeText', () => {
  it('escapes markup and nbsp only', () => {
    expect(encodeText('a<b>&c é')).toBe('a&lt;b&gt;&amp;c&nbsp;é')
  })
})

describe('CF_HTML', () => {
  const frag = '<html><body><!--StartFragment--><p>كتاب</p><!--EndFragment--></body></html>'
  const header = (sh: number, eh: number, sf: number, ef: number, extra = ''): string =>
    `Version:0.9\r\nStartHTML:${String(sh).padStart(10, '0')}\r\nEndHTML:${String(eh).padStart(10, '0')}\r\nStartFragment:${String(sf).padStart(10, '0')}\r\nEndFragment:${String(ef).padStart(10, '0')}\r\n${extra}`

  it('round-trips with byte-accurate offsets (UTF-8 multi-byte text)', () => {
    const built = buildCfHtml(frag, ['SourceURL:https://example.com/'])
    const parsed = parseCfHtml(Buffer.concat([built, Buffer.from([0])]))
    expect(parsed.html).toBe(frag)
    expect(parsed.extra).toEqual(['SourceURL:https://example.com/'])
    const s = built.toString('latin1')
    const num = (k: string): number => parseInt(new RegExp(`${k}:(\\d+)`).exec(s)![1], 10)
    expect(built.subarray(num('StartHTML'), num('EndHTML')).toString('utf8')).toBe(frag)
    expect(built.subarray(num('StartFragment'), num('EndFragment')).toString('utf8')).toBe(
      '<p>كتاب</p>'
    )
  })

  it('reads a real-looking header and ignores the trailing NUL', () => {
    const h0 = header(0, 0, 0, 0)
    const sh = Buffer.byteLength(h0)
    const buf = Buffer.from(header(sh, sh + Buffer.byteLength(frag), 0, 0) + frag + '\0', 'utf8')
    expect(parseCfHtml(buf).html).toBe(frag)
  })

  it('tolerates a payload without header and wraps it when building', () => {
    expect(parseCfHtml(Buffer.from('<p>x</p>')).html).toBe('<p>x</p>')
    const b = buildCfHtml('<p>نص</p>')
    const s = b.toString('utf8')
    expect(s).toContain('<!--StartFragment--><p>نص</p><!--EndFragment-->')
    expect(parseCfHtml(b).html).toContain('<p>نص</p>')
  })

  it('transforms through the whole clipboard path', () => {
    const built = buildCfHtml(
      '<html><head><style>p{color:red}</style></head><body><!--StartFragment--><p class=MsoNormal><span style="f:1">كتاب</span></p><!--EndFragment--></body></html>'
    )
    const cf = parseCfHtml(built)
    const doc = parseHtml(cf.html)
    const out = buildCfHtml(applyEditsToHtml(doc, diffText(doc.text, 'كِتَابٌ')), cf.extra)
    const back = parseCfHtml(out).html
    expect(back).toContain('<style>p{color:red}</style>')
    expect(back).toContain('<span style="f:1">كِتَابٌ</span>')
  })
})
