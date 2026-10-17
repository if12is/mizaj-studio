export type EngineState = 'loading' | 'ready' | 'missing'
export interface EnginesInfo {
  fast?: EngineState
  accurate?: EngineState
}

const STATES = new Set(['loading', 'ready', 'missing'])

/** Tolerant parse of /health `engines` (absent on older backends -> null). */
export function parseEngines(health: unknown): EnginesInfo | null {
  const e = (health as { engines?: Record<string, unknown> } | null)?.engines
  if (!e || typeof e !== 'object') return null
  const pick = (v: unknown): EngineState | undefined =>
    typeof v === 'string' && STATES.has(v) ? (v as EngineState) : undefined
  return { fast: pick(e.fast), accurate: pick(e.accurate) }
}

/** Status-bar text for the warm-up state; null when nothing needs saying. */
export function engineWarmupText(e: EnginesInfo | null): string | null {
  if (!e) return null
  if (e.accurate === 'loading') return 'المحرك الدقيق: جارٍ التحميل…'
  if (e.fast === 'loading') return 'المحرك السريع: جارٍ التحميل…'
  if (e.accurate === 'missing') return 'المحرك الدقيق: غير متوفر'
  return null
}
