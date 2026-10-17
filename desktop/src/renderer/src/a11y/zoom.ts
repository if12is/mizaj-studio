export const MIN_FONT = 12
export const MAX_FONT = 48
export const DEFAULT_FONT = 20
export const FONT_STEP = 2

export function nextFontSize(current: number, action: 'in' | 'out' | 'reset'): number {
  if (action === 'reset') return DEFAULT_FONT
  const n = current + (action === 'in' ? FONT_STEP : -FONT_STEP)
  return Math.min(MAX_FONT, Math.max(MIN_FONT, n))
}

/** Map a keydown to a zoom action: Ctrl/Cmd + '=' / '+' / '-' / '0'. */
export function zoomAction(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): 'in' | 'out' | 'reset' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  if (e.key === '=' || e.key === '+') return 'in'
  if (e.key === '-' || e.key === '_') return 'out'
  if (e.key === '0') return 'reset'
  return null
}
