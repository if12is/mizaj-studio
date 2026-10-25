import { describe, expect, it } from 'vitest'
import { hideSuggestionFence, renderMarkdown } from './safeMarkdown'

describe('incremental rendering of a streaming answer', () => {
  const full = 'الجواب **مهم**\n\n```mizaj-suggestion\nكَتَبَ\n```'
  it('never shows the suggestion fence, at any prefix of the stream', () => {
    for (let i = 0; i <= full.length; i++) {
      const shown = hideSuggestionFence(full.slice(0, i))
      expect(shown, `prefix ${i}`).not.toContain('mizaj')
      expect(shown, `prefix ${i}`).not.toContain('```')
    }
    expect(hideSuggestionFence(full).trim()).toBe('الجواب **مهم**')
  })
  it('re-rendering any prefix stays escaped (no raw HTML ever passes)', () => {
    const evil = '<img src=x onerror=alert(1)> **b** <script>x</script>'
    for (let i = 0; i <= evil.length; i++) {
      const html = renderMarkdown(hideSuggestionFence(evil.slice(0, i)))
      expect(html).not.toMatch(/<img|<script/)
    }
  })
})
