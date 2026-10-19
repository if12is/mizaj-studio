import { describe, expect, it } from 'vitest'
import { applyEdits, diffText, myers, previewSegments } from './textDiff'

const rt = (a: string, b: string): void => {
  const e = diffText(a, b)
  expect(applyEdits(a, e)).toBe(b)
  // sorted, non-overlapping
  for (let i = 1; i < e.length; i++) expect(e[i].start).toBeGreaterThanOrEqual(e[i - 1].end)
}

describe('diffText', () => {
  it('returns no edits for identical text', () => {
    expect(diffText('كتاب', 'كتاب')).toEqual([])
  })

  it('turns inserted diacritics into pure insertions', () => {
    const a = 'كتاب'
    const b = 'كَتَابٌ'
    const e = diffText(a, b)
    expect(e.every((x) => x.start === x.end)).toBe(true)
    expect(e.map((x) => x.insert)).toEqual(['َ', 'َ', 'ٌ'])
    expect(applyEdits(a, e)).toBe(b)
  })

  it('replaces a changed diacritic in place', () => {
    const e = diffText('كَتَبَ', 'كُتِبَ')
    expect(e).toEqual([
      { start: 1, end: 2, insert: 'ُ' },
      { start: 3, end: 4, insert: 'ِ' }
    ])
  })

  it('replaces a letter (hamza fix) and leaves the rest alone', () => {
    const e = diffText('قال ابو زيد', 'قال أبو زيد')
    expect(e).toEqual([{ start: 4, end: 5, insert: 'أ' }])
  })

  it('handles punctuation spacing changes', () => {
    rt('كلي ،وسهلي', 'كلي، وسهلي')
    const e = diffText('كلي ،وسهلي', 'كلي، وسهلي')
    expect(e.length).toBeGreaterThan(0)
    expect(e.reduce((n, x) => n + (x.end - x.start), 0)).toBeLessThanOrEqual(2)
  })

  it('does not split surrogate pairs', () => {
    rt('a😀b', 'a😁b')
    const e = diffText('a😀b', 'a😁b')
    expect(e).toEqual([{ start: 1, end: 3, insert: '😁' }])
    rt('😀', '😀😁')
  })

  it('handles empty sides', () => {
    rt('', 'نص')
    rt('نص', '')
    expect(diffText('', '')).toEqual([])
  })

  it('round-trips random edits (property test)', () => {
    let seed = 12345
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const alphabet = ['ا', 'ب', 'ت', 'َ', 'ُ', 'ّ', ' ', '،', '.', '\n', 'أ', '😀']
    for (let t = 0; t < 300; t++) {
      let a = ''
      for (let i = 0; i < rnd(60); i++) a += alphabet[rnd(alphabet.length)]
      let b = a
      for (let i = 0; i < rnd(6); i++) {
        const cps = Array.from(b)
        const pos = rnd(cps.length + 1)
        if (rnd(2)) cps.splice(pos, rnd(3), alphabet[rnd(alphabet.length)])
        else cps.splice(pos, 1)
        b = cps.join('')
      }
      rt(a, b)
    }
  })

  it('stays fast and correct on a long text with many changes', () => {
    const words = Array.from({ length: 4000 }, (_, i) => `كلمة${i % 7}`)
    const a = words.join(' ')
    const b = words.map((w, i) => (i % 3 === 0 ? w + 'ٌ' : w)).join(' ')
    const t0 = Date.now()
    rt(a, b)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('keeps edits fine-grained on a long text where every word changes (never one giant replacement)', () => {
    const a = Array.from({ length: 3000 }, () => 'كتاب').join(' ')
    const b = Array.from({ length: 3000 }, () => 'كِتَابٌ').join(' ')
    const e = diffText(a, b)
    expect(applyEdits(a, e)).toBe(b)
    expect(e.length).toBe(9000)
    expect(e.every((x) => x.start === x.end)).toBe(true)
  })

  it('keeps words aligned across hamza, ya and punctuation fixes', () => {
    const a = Array.from({ length: 2500 }, () => 'قال ابو زيد فى الدار ،ثم ذهب').join(' ')
    const b = Array.from({ length: 2500 }, () => 'قال أبو زيد في الدار، ثم ذهب').join(' ')
    const e = diffText(a, b)
    expect(applyEdits(a, e)).toBe(b)
    expect(e.length).toBeLessThan(2500 * 6)
    expect(Math.max(...e.map((x) => x.end - x.start))).toBeLessThanOrEqual(2)
  })

  it('falls back to a coarse replacement when the diff is huge, still correct', () => {
    const a = 'ab'.repeat(3000)
    const b = 'ba'.repeat(3000)
    rt(a, b)
  })
})

describe('myers', () => {
  it('gives null above the step limit', () => {
    expect(myers([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 3)).toBeNull()
  })
})

describe('previewSegments', () => {
  it('marks changed words and keeps the rest', () => {
    const seg = previewSegments('قال ابو زيد', 'قال أبو زيد')
    expect(seg).toEqual([
      { kind: 'same', text: 'قال ' },
      { kind: 'change', text: 'أبو', old: 'ابو', letters: true },
      { kind: 'same', text: ' زيد' }
    ])
  })

  it('flags mark-only changes as non-letter changes', () => {
    const seg = previewSegments('كتاب جديد', 'كِتابٌ جديد')
    expect(seg[0]).toMatchObject({ kind: 'change', letters: false })
    expect(seg.map((s) => s.text).join('')).toBe('كِتابٌ جديد')
  })

  it('joins into the processed text', () => {
    const a = 'ذهب الولد إلى المدرسة ،وعاد'
    const b = 'ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ، وَعَادَ'
    expect(
      previewSegments(a, b)
        .map((s) => s.text)
        .join('')
    ).toBe(b)
  })
})
