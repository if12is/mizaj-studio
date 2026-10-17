import { describe, expect, it } from 'vitest'
import { contrastRatio, HC } from './contrast'
import { nextFontSize, MIN_FONT, MAX_FONT, DEFAULT_FONT } from './zoom'

describe('WCAG contrast', () => {
  it('computes known ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(contrastRatio('#777777', '#ffffff')).toBeGreaterThan(4.4)
  })
  it('high-contrast palette meets WCAG AA (>= 4.5:1) for text and AAA (>= 7:1) for diacritics', () => {
    for (const fg of [HC.fg, HC.muted, HC.accent, HC.danger, HC.warning, HC.focus])
      expect(contrastRatio(fg, HC.bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(HC.fg, HC.bg)).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(HC.marksEmerald, HC.bg)).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(HC.marksAmber, HC.bg)).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(HC.accentFg, HC.accent)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(HC.focus, HC.bg)).toBeGreaterThanOrEqual(3)
  })
})

describe('zoom', () => {
  it('steps and clamps the editor font size', () => {
    expect(nextFontSize(20, 'in')).toBe(22)
    expect(nextFontSize(20, 'out')).toBe(18)
    expect(nextFontSize(20, 'reset')).toBe(DEFAULT_FONT)
    expect(nextFontSize(MAX_FONT, 'in')).toBe(MAX_FONT)
    expect(nextFontSize(MIN_FONT, 'out')).toBe(MIN_FONT)
  })
})
