import { describe, expect, it } from 'vitest'
import { engineWarmupText, parseEngines } from './engines'

describe('engines health parsing', () => {
  it('degrades gracefully when the field is absent or malformed', () => {
    expect(parseEngines({ status: 'ok' })).toBeNull()
    expect(parseEngines(null)).toBeNull()
    expect(parseEngines({ engines: 'x' })).toBeNull()
    expect(parseEngines({ engines: { fast: 'weird' } })).toEqual({
      fast: undefined,
      accurate: undefined
    })
  })
  it('parses states', () => {
    expect(parseEngines({ engines: { fast: 'ready', accurate: 'loading' } })).toEqual({
      fast: 'ready',
      accurate: 'loading'
    })
  })
  it('warm-up text', () => {
    expect(engineWarmupText(null)).toBeNull()
    expect(engineWarmupText({ fast: 'ready', accurate: 'loading' })).toBe(
      'المحرك الدقيق: جارٍ التحميل…'
    )
    expect(engineWarmupText({ fast: 'loading', accurate: 'ready' })).toBe(
      'المحرك السريع: جارٍ التحميل…'
    )
    expect(engineWarmupText({ fast: 'ready', accurate: 'missing' })).toBe(
      'المحرك الدقيق: غير متوفر'
    )
    expect(engineWarmupText({ fast: 'ready', accurate: 'ready' })).toBeNull()
  })
})
