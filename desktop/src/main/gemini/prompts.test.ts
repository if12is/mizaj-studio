import { describe, expect, it } from 'vitest'
import {
  buildDocumentPrompt,
  buildSelectionPrompt,
  docLimit,
  MAX_DOC_CHARS,
  parseReply,
  SYSTEM_PROMPT,
  systemPromptFor,
  truncateDocument
} from './prompts'

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
    expect(buildDocumentPrompt('س؟', 'ب'.repeat(MAX_DOC_CHARS + 1)).truncated).toBe(true)
    expect(buildDocumentPrompt('س؟', 'ب'.repeat(100_000)).truncated).toBe(false) // a long memo is sent whole
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
  it('limits follow the model input limit when known', () => {
    expect(docLimit()).toBe(MAX_DOC_CHARS)
    expect(docLimit(1_048_576)).toBe(MAX_DOC_CHARS)
    expect(docLimit(100_000)).toBe(180_000)
  })
  it('document questions get no suggestion block; selections only short ones', () => {
    const blk = (x: string) => `جواب\n\`\`\`mizaj-suggestion\n${x}\n\`\`\``
    expect(parseReply(blk('كَتَبَ'), 'document').suggestion).toBeNull()
    expect(parseReply(blk('كَتَبَ'), 'selection').suggestion).toBe('كَتَبَ')
    expect(parseReply(blk('ا'.repeat(400)), 'selection').suggestion).toBeNull()
    expect(parseReply(blk('ا'.repeat(400)), 'word').suggestion).not.toBeNull()
  })
  it('system prompts: grammar guidance, legal context, per-kind suggestion rules', () => {
    const sel = systemPromptFor('selection')
    for (const w of ['غير متأكد', 'موقعها الإعرابي', 'المدعى عليه', 'المدعي', 'أبو حمص'])
      expect(sel).toContain(w)
    expect(sel).toContain('mizaj-suggestion')
    expect(systemPromptFor('document')).not.toContain('```mizaj-suggestion')
  })
  it('selection prompt includes the containing sentence', () => {
    const p = buildSelectionPrompt('أعرب', 'المدعى', 'أقام المدعي الدعوى ضد المدعى عليه.')
    expect(p).toContain('الجملة التي ترد فيها')
    expect(p).toContain('ضد المدعى عليه')
  })
})
