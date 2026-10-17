import { describe, expect, it } from 'vitest'
import { cleanText, htmlToPlainText } from './paste'

const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{mso-style-name:x}</style>
<!--[if gte mso 9]><xml><w:WordDocument></w:WordDocument></xml><![endif]--></head><body>
<!--StartFragment--><p class=MsoNormal dir=RTL style='text-align:right'><span lang=AR-SA style='font-family:"Traditional Arabic"'>كَتَبَ&nbsp;الوَلَدُ
الدَّرسَ</span><o:p></o:p></p>
<p class=MsoNormal dir=RTL><span>الفقرة الثانية&#8207; مع <b>خط عريض</b>.</span><br>سطر جديد</p>
<ul><li>بند أول</li><li>بند ثان</li></ul>
<table><tr><td>أ</td><td>ب</td></tr></table><!--EndFragment--></body></html>`

describe('rich paste from Word', () => {
  it('keeps paragraphs and line breaks, drops styling and junk, preserves diacritics', () => {
    const t = htmlToPlainText(word)
    expect(t).toBe(
      'كَتَبَ الوَلَدُ الدَّرسَ\nالفقرة الثانية مع خط عريض.\nسطر جديد\n• بند أول\n• بند ثان\nأ\tب'
    )
    expect(t).not.toMatch(/mso|style|<|xml|\[if/i)
  })
  it('removes invisible direction controls and NBSP', () => {
    expect(cleanText('ا‏ب‪ج د﻿')).toBe('ابج د')
    expect(htmlToPlainText('<p>a&nbsp;b&rlm;c</p>')).toBe('a bc')
  })
  it('can merge lines into one paragraph', () => {
    expect(htmlToPlainText('<p>أول</p><p>ثان</p><p>ثالث</p>', { keepParagraphs: false })).toBe(
      'أول ثان ثالث'
    )
  })
  it('decodes numeric and named entities, tolerates plain fragments', () => {
    expect(htmlToPlainText('x &#1575;&#x0644;&amp;&lt;y&gt; &laquo;ن&raquo;')).toBe('x ال&<y> «ن»')
    expect(htmlToPlainText('نص بلا وسوم')).toBe('نص بلا وسوم')
    expect(htmlToPlainText('')).toBe('')
  })
})
