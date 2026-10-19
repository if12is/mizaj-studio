import type { SystemwideConfig } from './config'
import {
  SHORTCUT_ERROR_AR,
  SHORTCUT_IDS,
  conflictMessageAr,
  validateShortcutSet,
  type ShortcutId
} from './shortcuts'

/**
 * Registers the configured global shortcuts through an injected registrar (Electron's globalShortcut
 * in the app, a fake in tests). Everything is unregistered when the feature is disabled and on quit.
 * `register` returning false means another program (or the system) owns the shortcut: the user is
 * told, nothing is retried silently.
 */
export interface Registrar {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export type ShortcutState = 'off' | 'registered' | 'conflict' | 'invalid'

export interface ShortcutStatus {
  state: ShortcutState
  /** the normalised accelerator ('' when unset) */
  accelerator: string
  /** Arabic explanation for `conflict` / `invalid` */
  message: string
}

export type StatusMap = Record<ShortcutId, ShortcutStatus>

/** Key-repeat guard: the same shortcut fired again within this window is ignored. */
export const DEBOUNCE_MS = 500

export class ShortcutRegistry {
  private active: string[] = []
  private lastFire = new Map<ShortcutId, number>()

  constructor(
    private readonly registrar: Registrar,
    private readonly onFire: (id: ShortcutId) => void,
    private readonly now: () => number = Date.now
  ) {}

  get registered(): readonly string[] {
    return this.active
  }

  /** (Re)register according to `cfg`. Always starts from a clean slate. */
  apply(cfg: SystemwideConfig): StatusMap {
    this.unregisterAll()
    const status = {} as StatusMap
    const chk = validateShortcutSet(cfg.shortcuts)
    for (const id of SHORTCUT_IDS) {
      const acc = chk.accelerators[id]
      const err = chk.errors[id]
      if (err)
        status[id] = {
          state: 'invalid',
          accelerator: cfg.shortcuts[id],
          message: SHORTCUT_ERROR_AR[err]
        }
      else status[id] = { state: 'off', accelerator: acc, message: '' }
    }
    if (!cfg.enabled) return status
    for (const id of SHORTCUT_IDS) {
      const acc = chk.accelerators[id]
      if (!acc || status[id].state === 'invalid') continue
      let ok = false
      try {
        ok = this.registrar.register(acc, () => this.fire(id))
      } catch {
        ok = false
      }
      if (ok) {
        this.active.push(acc)
        status[id] = { state: 'registered', accelerator: acc, message: '' }
      } else {
        status[id] = { state: 'conflict', accelerator: acc, message: conflictMessageAr(id, acc) }
      }
    }
    return status
  }

  unregisterAll(): void {
    for (const acc of this.active) {
      try {
        this.registrar.unregister(acc)
      } catch {
        /* already gone */
      }
    }
    this.active = []
  }

  private fire(id: ShortcutId): void {
    const t = this.now()
    const last = this.lastFire.get(id)
    if (last !== undefined && t - last < DEBOUNCE_MS) return
    this.lastFire.set(id, t)
    this.onFire(id)
  }
}
