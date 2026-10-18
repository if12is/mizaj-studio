/** Pure sizing rules for the resizable / dockable side panel (unit-tested). */

export const PANEL_MIN_W = 240
export const PANEL_MAX_W = 720
export const PANEL_MIN_H = 140
export const PANEL_MAX_H = 560
export const PANEL_DEFAULT_W = 320
export const PANEL_DEFAULT_H = 260
export const KEY_STEP = 16
export const KEY_STEP_BIG = 64

export type PanelDock = 'side' | 'bottom'

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Max size also respects the window so the editor always keeps room. */
export function maxFor(dock: PanelDock, viewport: number): number {
  return dock === 'side'
    ? Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, Math.floor(viewport * 0.6)))
    : Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, Math.floor(viewport * 0.6)))
}

export function clampSize(dock: PanelDock, size: number, viewport: number): number {
  const lo = dock === 'side' ? PANEL_MIN_W : PANEL_MIN_H
  return clamp(Math.round(size), lo, maxFor(dock, viewport))
}

/** Parse a saved value; invalid / missing -> null (caller falls back to the default). */
export function parseSize(raw: string | undefined): number | null {
  if (!raw || !/^\d{2,4}$/.test(raw)) return null
  return Number(raw)
}

export function parseDock(raw: string | undefined): PanelDock {
  return raw === 'bottom' ? 'bottom' : 'side'
}

/**
 * Keyboard resize. `growKey` is the arrow that makes the panel bigger for the current placement
 * (side panel on the physical left of a RTL layout: ArrowRight; bottom dock: ArrowUp).
 */
export function keyboardSize(
  dock: PanelDock,
  current: number,
  key: string,
  shift: boolean,
  growKey: string,
  viewport: number
): number | null {
  const step = shift ? KEY_STEP_BIG : KEY_STEP
  const shrinkKey = {
    ArrowRight: 'ArrowLeft',
    ArrowLeft: 'ArrowRight',
    ArrowUp: 'ArrowDown',
    ArrowDown: 'ArrowUp'
  }[growKey]
  if (key === growKey) return clampSize(dock, current + step, viewport)
  if (key === shrinkKey) return clampSize(dock, current - step, viewport)
  if (key === 'Home') return clampSize(dock, 0, viewport)
  if (key === 'End') return clampSize(dock, 99999, viewport)
  return null
}
