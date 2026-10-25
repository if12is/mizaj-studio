import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DEFAULT_IDLE_SEC, MAX_IDLE_SEC, MIN_IDLE_SEC } from './api'

/** Non-secret Gemini assistant settings; kept by the main process so it can enforce them. */
export interface GeminiConfig {
  enabled: boolean
  model: string
  /** ISO time the user accepted the "text is sent to Google" notice; null = not yet */
  consentAt: string | null
  /** abort a generation when no data arrives for this many seconds (never a total cap) */
  idleTimeoutSec: number
}

export const DEFAULT_CONFIG: GeminiConfig = {
  enabled: false,
  model: '',
  consentAt: null,
  idleTimeoutSec: DEFAULT_IDLE_SEC
}

export function sanitizeConfig(raw: unknown): GeminiConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    enabled: o.enabled === true,
    model: typeof o.model === 'string' && /^[A-Za-z0-9._\-/]{0,120}$/.test(o.model) ? o.model : '',
    consentAt: typeof o.consentAt === 'string' && o.consentAt.length < 40 ? o.consentAt : null,
    idleTimeoutSec:
      typeof o.idleTimeoutSec === 'number' && Number.isFinite(o.idleTimeoutSec)
        ? Math.min(MAX_IDLE_SEC, Math.max(MIN_IDLE_SEC, Math.round(o.idleTimeoutSec)))
        : DEFAULT_IDLE_SEC
  }
}

export class GeminiConfigStore {
  private cache: GeminiConfig | null = null
  constructor(private readonly file: string) {}

  get(): GeminiConfig {
    if (this.cache) return this.cache
    let raw: unknown = null
    try {
      if (existsSync(this.file)) raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      raw = null
    }
    this.cache = sanitizeConfig(raw)
    // The removed Gemini CLI mode: settings that chose it simply become API-key settings, and the
    // file is rewritten without the obsolete fields.
    const old = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    if (old && ('provider' in old || 'useCli' in old)) {
      try {
        this.write(this.cache)
      } catch {
        /* best effort; the in-memory config is already migrated */
      }
    }
    return this.cache
  }

  /** Merge a renderer patch; `consentAt` can only be set through acceptConsent(). */
  update(patch: unknown): GeminiConfig {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
    const cur = this.get()
    const next = sanitizeConfig({ ...cur, ...p, consentAt: cur.consentAt })
    return this.write(next)
  }

  acceptConsent(now: () => Date = () => new Date()): GeminiConfig {
    const cur = this.get()
    return this.write({ ...cur, consentAt: cur.consentAt ?? now().toISOString() })
  }

  private write(c: GeminiConfig): GeminiConfig {
    this.cache = c
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 })
    renameSync(tmp, this.file)
    return c
  }
}
