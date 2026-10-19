import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './safeMarkdown'

describe('renderMarkdown', () => {
  it('renders bold, lists, headings and line breaks', () => {
    const h = renderMarkdown('## عنوان\n**الدفع الإجرائي:** نص\nسطر ثان\n\n1. أول\n2. ثان\n- نقطة')
    expect(h).toContain('<strong>الدفع الإجرائي:</strong>')
    expect(h).toContain('<h4>عنوان</h4>')
    expect(h).toContain('<br>')
    expect(h).toContain('<ol><li>أول</li><li>ثان</li></ol>')
    expect(h).toContain('<ul><li>نقطة</li></ul>')
    expect(h).not.toContain('**')
  })
  it('never passes HTML or executable links through', () => {
    const h = renderMarkdown(
      '<img src=x onerror=alert(1)> <script>x</script> [اضغط](javascript:alert(1))'
    )
    expect(h).not.toContain('<img')
    expect(h).not.toContain('<script')
    expect(h).not.toContain('<a')
    expect(h).toContain('&lt;img')
    expect(h).toContain('اضغط (javascript:alert(1))')
  })
})
