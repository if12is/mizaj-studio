/**
 * Turn a keydown into an Electron accelerator string for the shortcut recorder.
 * `KeyboardEvent.code` (physical key) is used, never `key`: on an Arabic keyboard layout `key` is an
 * Arabic letter, but the accelerator must name the physical key («M», not «ة»).
 * Only the syntax is produced here; the main process validates and normalises it.
 */
const NAMED: Record<string, string> = {
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Tab: 'Tab',
  Enter: 'Enter',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`'
}

export interface KeyLike {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export function keyFromCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]
  m = /^Digit([0-9])$/.exec(code)
  if (m) return m[1]
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (m) return `F${m[1]}`
  m = /^Numpad([0-9])$/.exec(code)
  if (m) return `num${m[1]}`
  return NAMED[code] ?? null
}

/** null while only modifiers are held, for the Windows key, and for keys Electron cannot name. */
export function acceleratorFromEvent(e: KeyLike): string | null {
  if (e.metaKey) return null
  const key = keyFromCode(e.code)
  if (!key) return null
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key]
    .filter(Boolean)
    .join('+')
}
