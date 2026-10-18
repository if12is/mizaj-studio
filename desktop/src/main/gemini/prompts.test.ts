import { describe, expect, it } from 'vitest'
import { buildDocumentPrompt, parseReply, SYSTEM_PROMPT, truncateDocument } from './prompts'

describe('prompts', () => {
  it('system prompt keeps the assistant limited', () => {
    expect(SYSTEM_PROMPT).toContain('بالعربية')
    expect(SYSTEM_PROMPT).toContain('القاعدة')
    expect(SYSTEM_PROMPT).toContain('mizaj-suggestion')
  })
  it('truncates long documents and flags it', () => {
    const t = truncateDocument('ا'.repeat(100), 40)
    expect(t.truncated).toBe(true)
    expect(t.text.length).toBeLessThan(100)
    expect(truncateDocument('قصير').truncated).toBe(false)
    expect(buildDocumentPrompt('س؟', 'ب'.repeat(50_000)).truncated).toBe(true)
  })
  it('extracts the structured suggestion block', () => {
    const r = parseReply('الإعراب خاطئ.\n```mizaj-suggestion\nذَهَبَ الوَلَدُ\n```\nوالله أعلم')
    expect(r.suggestion).toBe('ذَهَبَ الوَلَدُ')
    expect(r.text).not.toContain('mizaj-suggestion')
    expect(r.text).toContain('الإعراب خاطئ')
  })
  it('no block means no suggestion', () => {
    expect(parseReply('لا تغيير').suggestion).toBeNull()
  })
})
