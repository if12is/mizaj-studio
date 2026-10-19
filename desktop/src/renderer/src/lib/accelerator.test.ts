import { describe, expect, it } from 'vitest'
import { acceleratorFromEvent, keyFromCode } from './accelerator'

const ev = (
  code: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}
) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('acceleratorFromEvent', () => {
  it('uses the physical key, so an Arabic layout still gives Ctrl+Alt+M', () => {
    expect(acceleratorFromEvent(ev('KeyM', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+M')
  })
  it('orders modifiers Ctrl, Alt, Shift', () => {
    expect(acceleratorFromEvent(ev('F9', { shiftKey: true, altKey: true, ctrlKey: true }))).toBe(
      'Ctrl+Alt+Shift+F9'
    )
  })
  it('maps digits, numpad, arrows and punctuation', () => {
    expect(keyFromCode('Digit1')).toBe('1')
    expect(keyFromCode('Numpad4')).toBe('num4')
    expect(keyFromCode('ArrowUp')).toBe('Up')
    expect(keyFromCode('Slash')).toBe('/')
    expect(keyFromCode('F24')).toBe('F24')
  })
  it('ignores pure modifiers, the Windows key and unknown keys', () => {
    expect(acceleratorFromEvent(ev('ControlLeft', { ctrlKey: true }))).toBeNull()
    expect(acceleratorFromEvent(ev('ShiftRight', { shiftKey: true }))).toBeNull()
    expect(acceleratorFromEvent(ev('KeyM', { ctrlKey: true, metaKey: true }))).toBeNull()
    expect(acceleratorFromEvent(ev('IntlRo'))).toBeNull()
    expect(keyFromCode('F25')).toBeNull()
  })
})
