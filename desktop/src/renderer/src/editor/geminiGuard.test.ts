import { describe, expect, it } from 'vitest'
import { diffMarkEdits } from './markEdits'

// A Gemini suggestion may be applied only if base letters are identical (marks-only change).
describe('Gemini suggestion base-letter guard', () => {
  it('accepts a marks-only change', () => {
    const edits = diffMarkEdits('ذهب الولد', 'ذَهَبَ الوَلَدُ', 0)
    expect(edits).not.toBeNull()
    expect(edits!.length).toBeGreaterThan(0)
  })
  it('rejects a suggestion that changes a base letter', () => {
    expect(diffMarkEdits('ذهب الولد', 'ذَهَبَ الوَلَدَانِ', 0)).toBeNull()
  })
  it('rejects added or removed words', () => {
    expect(diffMarkEdits('ذهب الولد', 'ذَهَبَ', 0)).toBeNull()
  })
})
