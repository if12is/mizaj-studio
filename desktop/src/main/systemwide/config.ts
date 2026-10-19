import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_MAIN_SHORTCUT,
  SHORTCUT_IDS,
  validateAccelerator,
  validateShortcutSet,
  type ShortcutError,
  type ShortcutId,
  type ShortcutMap
} from './shortcuts'

export type ReplaceMode = 'preview' | 'direct'

export interface SystemwideConfig {
  /** master switch: nothing is registered or automated while false (default) */
  enabled: boolean
  /** keep the app in the tray when its window is closed (needed for the shortcuts to keep working) */
  runInBackground: boolean
  /** «طريقة الاستبدال»: show a preview first (default) or replace straight away */
  replaceMode: ReplaceMode
  /** '' = no shortcut for that operation */
  shortcuts: ShortcutMap
}

export const DEFAULT_CONFIG: SystemwideConfig = {
  enabled: false,
  runInBackground: false,
  replaceMode: 'preview',
  shortcuts: {
    main: DEFAULT_MAIN_SHORTCUT,
    proofread: '',
    punctuation: '',
    tashkeel: '',
    all: ''
  }
}

export const cloneDefault = (): SystemwideConfig => ({
  ...DEFAULT_CONFIG,
  shortcuts: { ...DEFAULT_CONFIG.shortcuts }
})

/** Tolerant reader for the stored file: anything unusable falls back to the (off) defaults. */
export function sanitizeConfig(raw: unknown): SystemwideConfig {
  const out = cloneDefault()
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.runInBackground === 'boolean') out.runInBackground = r.runInBackground
  if (r.replaceMode === 'direct' || r.replaceMode === 'preview') out.replaceMode = r.replaceMode
  if (r.shortcuts && typeof r.shortcuts === 'object') {
    const s = r.shortcuts as Record<string, unknown>
    const cand: Partial<Record<ShortcutId, string>> = {}
    for (const id of SHORTCUT_IDS) if (typeof s[id] === 'string') cand[id] = s[id] as string
    out.shortcuts = validateShortcutSet({ ...out.shortcuts, ...cand }).accelerators
    if (cand.main === '') out.shortcuts.main = ''
  }
  return out
}

export interface PatchResult {
  config: SystemwideConfig
  /** per-field validation errors; the offending fields keep their previous value */
  errors: Partial<Record<ShortcutId, ShortcutError>> & {
    replaceMode?: 'invalid'
    enabled?: 'invalid'
  }
}

/** Strict validation of an untrusted patch coming over IPC. Unknown keys are ignored. */
export function applyPatch(cur: SystemwideConfig, patch: unknown): PatchResult {
  const next: SystemwideConfig = { ...cur, shortcuts: { ...cur.shortcuts } }
  const errors: PatchResult['errors'] = {}
  if (!patch || typeof patch !== 'object') return { config: next, errors }
  const p = patch as Record<string, unknown>
  if ('enabled' in p) {
    if (typeof p.enabled === 'boolean') next.enabled = p.enabled
    else errors.enabled = 'invalid'
  }
  if ('runInBackground' in p && typeof p.runInBackground === 'boolean')
    next.runInBackground = p.runInBackground
  if ('replaceMode' in p) {
    if (p.replaceMode === 'preview' || p.replaceMode === 'direct') next.replaceMode = p.replaceMode
    else errors.replaceMode = 'invalid'
  }
  if (p.shortcuts && typeof p.shortcuts === 'object') {
    const s = p.shortcuts as Record<string, unknown>
    const set: [ShortcutId, string][] = []
    for (const id of SHORTCUT_IDS) {
      if (!(id in s)) continue
      const v = s[id]
      if (typeof v !== 'string') errors[id] = 'syntax'
      else if (v === '')
        next.shortcuts[id] = '' // clearing first lets two shortcuts be swapped in one patch
      else {
        const r = validateAccelerator(v)
        if (!r.ok) errors[id] = r.error
        else set.push([id, r.accelerator])
      }
    }
    // every shortcut being replaced is freed first, so a swap between two of them is allowed
    const before = { ...next.shortcuts }
    for (const [id] of set) next.shortcuts[id] = ''
    for (const [id, acc] of set) {
      const clash = SHORTCUT_IDS.some(
        (o) =>
          o !== id &&
          next.shortcuts[o] !== '' &&
          next.shortcuts[o].toLowerCase() === acc.toLowerCase()
      )
      if (clash) {
        errors[id] = 'duplicate'
        next.shortcuts[id] = before[id]
      } else next.shortcuts[id] = acc
    }
  }
  return { config: next, errors }
}

/** `<userData>/systemwide-config.json`, written atomically. No text of any document is ever stored here. */
export class SystemwideConfigStore {
  constructor(private readonly file: string) {}

  load(): SystemwideConfig {
    try {
      if (!existsSync(this.file)) return cloneDefault()
      return sanitizeConfig(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return cloneDefault()
    }
  }

  save(c: SystemwideConfig): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(c, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
