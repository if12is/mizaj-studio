import { describe, expect, it } from 'vitest'
import { processParagraphs } from './process'

describe('processParagraphs: whitespace around a paragraph break', () => {
  const item = {
    start: 0,
    end: 1,
    original: 'a',
    replacement: 'b',
    category: 'punctuation' as const
  }
  const base = {
    proofread: async () => ({ items: [item] }),
    tashkeel: async (t: string) => ({ text: t })
  }
  it('an engine that eats spaces around the break still maps per paragraph', async () => {
    const deps = {
      ...base,
      apply: async (t: string) => ({ text: t.replace(/ +\n +/g, '\n'), applied: 1, skipped: 0 })
    }
    const r = await processParagraphs({ op: 'punctuation', paragraphs: ['كتاب  ', '  قلم'] }, deps)
    expect(r.changed).toBe(true)
    expect(r.edits[0].length + r.edits[1].length).toBeGreaterThan(0)
    expect(r.edits[0].every((e) => e.end <= 6)).toBe(true)
    expect(r.edits[1].every((e) => e.end <= 5)).toBe(true)
  })
  it('an engine that changes the line count is processed paragraph by paragraph', async () => {
    const deps = {
      ...base,
      apply: async (t: string) => ({ text: t.replace('\n', ' '), applied: 1, skipped: 0 })
    }
    const r = await processParagraphs({ op: 'punctuation', paragraphs: ['كتاب', 'قلم'] }, deps)
    // each paragraph alone has no newline to change: nothing to edit, and no failure
    expect(r.edits).toEqual([[], []])
  })
})
