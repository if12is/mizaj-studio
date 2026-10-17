/** WCAG 2.x contrast helpers and the palettes we ship (7.5.3). */
function lin(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
export function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16)
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** High-contrast (dark) palette. Keep in sync with `html.hc` in main.css. */
export const HC = {
  bg: '#000000',
  fg: '#ffffff',
  muted: '#d4d4d4',
  focus: '#ffd60a',
  accent: '#34d399',
  accentFg: '#000000',
  danger: '#ff8a80',
  warning: '#ffd60a',
  border: '#ffffff',
  /** COLR palette entries 0/1 (marks) must read >= 7:1 against bg */
  marksEmerald: '#10b981',
  marksAmber: '#f59e0b'
} as const
