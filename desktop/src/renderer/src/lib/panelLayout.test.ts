import { describe, expect, it } from 'vitest'
import {
  clampSize,
  keyboardSize,
  maxFor,
  parseDock,
  parseSize,
  PANEL_MAX_W,
  PANEL_MIN_H,
  PANEL_MIN_W
} from './panelLayout'

describe('panel layout', () => {
  it('clamps width to min/max and to the window', () => {
    expect(clampSize('side', 10, 1400)).toBe(PANEL_MIN_W)
    expect(clampSize('side', 5000, 2000)).toBe(PANEL_MAX_W)
    expect(clampSize('side', 5000, 800)).toBe(480) // 60% of a narrow window
    expect(maxFor('bottom', 300)).toBe(PANEL_MIN_H + 40)
  })
  it('parses saved values defensively', () => {
    expect(parseSize('320')).toBe(320)
    expect(parseSize('abc')).toBeNull()
    expect(parseSize(undefined)).toBeNull()
    expect(parseDock('bottom')).toBe('bottom')
    expect(parseDock('weird')).toBe('side')
  })
  it('resizes with arrow keys, shift for big steps, Home/End for the extremes', () => {
    expect(keyboardSize('side', 320, 'ArrowRight', false, 'ArrowRight', 1400)).toBe(336)
    expect(keyboardSize('side', 320, 'ArrowLeft', false, 'ArrowRight', 1400)).toBe(304)
    expect(keyboardSize('side', 320, 'ArrowRight', true, 'ArrowRight', 1400)).toBe(384)
    expect(keyboardSize('bottom', 260, 'ArrowUp', false, 'ArrowUp', 900)).toBe(276)
    expect(keyboardSize('side', 320, 'Home', false, 'ArrowRight', 1400)).toBe(PANEL_MIN_W)
    expect(keyboardSize('side', 320, 'End', false, 'ArrowRight', 2000)).toBe(PANEL_MAX_W)
    expect(keyboardSize('side', 320, 'a', false, 'ArrowRight', 1400)).toBeNull()
  })
})
