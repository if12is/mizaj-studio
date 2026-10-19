/**
 * Global shortcut configuration rules (pure). The accelerator syntax is Electron's; on top of it
 * a system-wide shortcut must carry Ctrl or Alt (a bare letter or Shift+letter would steal typing
 * in every program), must not use the Windows key (reserved by the OS) and must not collide with
 * the editing keys the feature itself sends (Ctrl+C / Ctrl+V) or with core system combinations.
 */

export const SHORTCUT_IDS = ['main', 'proofread', 'punctuation', 'tashkeel', 'all'] as const
export type ShortcutId = (typeof SHORTCUT_IDS)[number]

export const DEFAULT_MAIN_SHORTCUT = 'Ctrl+Alt+M'

export const SHORTCUT_LABEL_AR: Record<ShortcutId, string> = {
  main: 'النافذة الصغيرة (مِزَاج في أي برنامج)',
  proofread: 'تدقيق إملائي',
  punctuation: 'ترقيم',
  tashkeel: 'تشكيل',
  all: 'الكل'
}

export type ShortcutError =
  | 'syntax'
  | 'too_long'
  | 'no_modifier'
  | 'windows_key'
  | 'reserved'
  | 'duplicate'

export const SHORTCUT_ERROR_AR: Record<ShortcutError, string> = {
  syntax: 'صيغة الاختصار غير صالحة. مثال صحيح: Ctrl+Alt+M',
  too_long: 'الاختصار طويل جداً.',
  no_modifier: 'يجب أن يحتوي الاختصار على Ctrl أو Alt مع حرف أو مفتاح.',
  windows_key: 'لا يمكن استعمال مفتاح ويندوز في الاختصار لأن النظام يحجزه.',
  reserved:
    'هذا الاختصار محجوز للنظام أو لأوامر النسخ واللصق التي تستعملها الميزة نفسها. اختر غيره.',
  duplicate: 'الاختصار نفسه مستعمل لإجراء آخر. لكل إجراء اختصار مختلف.'
}

const MODIFIER_ALIASES: Record<string, 'Ctrl' | 'Alt' | 'Shift' | 'Win'> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'Alt',
  shift: 'Shift',
  super: 'Win',
  meta: 'Win',
  command: 'Win',
  cmd: 'Win'
}

const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  return: 'Enter',
  enter: 'Enter',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Esc',
  esc: 'Esc',
  plus: 'Plus',
  numadd: 'numadd',
  numsub: 'numsub',
  nummult: 'nummult',
  numdiv: 'numdiv',
  numdec: 'numdec'
}
const PUNCT = new Set(')!@#$%^&*(:;<>,._?/~`{}[]|\\\'"-=')

/** Normalise a key token, or null if Electron would not understand it. */
function normaliseKey(raw: string): string | null {
  if (raw.length === 1) {
    if (/[a-z]/i.test(raw)) return raw.toUpperCase()
    if (/[0-9]/.test(raw) || PUNCT.has(raw)) return raw
    return null
  }
  const low = raw.toLowerCase()
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(low)) return low.toUpperCase()
  if (/^num[0-9]$/.test(low)) return low
  return NAMED_KEYS[low] ?? null
}

export interface ParsedAccelerator {
  ctrl: boolean
  alt: boolean
  shift: boolean
  win: boolean
  key: string
}

export function parseAccelerator(acc: string): ParsedAccelerator | null {
  if (typeof acc !== 'string') return null
  const parts: string[] = []
  // "Ctrl++" means Ctrl and the plus key
  const src = acc.trim().replace(/\+\+$/, '+Plus')
  for (const p of src.split('+')) parts.push(p.trim())
  if (parts.length === 0 || parts.some((p) => p === '')) return null
  const out: ParsedAccelerator = { ctrl: false, alt: false, shift: false, win: false, key: '' }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const mod = MODIFIER_ALIASES[p.toLowerCase()]
    if (i < parts.length - 1) {
      if (!mod) return null
      if (mod === 'Ctrl') out.ctrl = true
      else if (mod === 'Alt') out.alt = true
      else if (mod === 'Shift') out.shift = true
      else out.win = true
    } else {
      if (mod) return null // modifier only
      const k = normaliseKey(p)
      if (!k) return null
      out.key = k
    }
  }
  return out
}

export function canonicalAccelerator(p: ParsedAccelerator): string {
  return [p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.win && 'Super', p.key]
    .filter(Boolean)
    .join('+')
}

/** Combinations that are never allowed (canonical form). */
const RESERVED = new Set([
  'Ctrl+C',
  'Ctrl+V',
  'Ctrl+X',
  'Ctrl+Z',
  'Ctrl+Y',
  'Ctrl+A',
  'Ctrl+Insert',
  'Shift+Insert',
  'Shift+Delete',
  'Alt+F4',
  'Alt+Tab',
  'Alt+Esc',
  'Alt+Space',
  'Ctrl+Esc',
  'Ctrl+Shift+Esc',
  'Ctrl+Alt+Delete',
  'Ctrl+Alt+Tab',
  'Ctrl+Alt+Esc'
])

export type AcceleratorCheck =
  | { ok: true; accelerator: string }
  | { ok: false; error: ShortcutError }

export function validateAccelerator(acc: unknown): AcceleratorCheck {
  if (typeof acc !== 'string') return { ok: false, error: 'syntax' }
  if (acc.length > 64) return { ok: false, error: 'too_long' }
  const p = parseAccelerator(acc)
  if (!p) return { ok: false, error: 'syntax' }
  if (p.win) return { ok: false, error: 'windows_key' }
  if (!p.ctrl && !p.alt) return { ok: false, error: 'no_modifier' }
  const canon = canonicalAccelerator(p)
  if (RESERVED.has(canon)) return { ok: false, error: 'reserved' }
  return { ok: true, accelerator: canon }
}

export type ShortcutMap = Record<ShortcutId, string>

export interface ShortcutSetCheck {
  /** normalised, valid accelerators only ('' for unset or invalid) */
  accelerators: ShortcutMap
  errors: Partial<Record<ShortcutId, ShortcutError>>
}

/** Validate every shortcut and detect duplicates between them. An empty string means "no shortcut". */
export function validateShortcutSet(map: Partial<Record<ShortcutId, string>>): ShortcutSetCheck {
  const accelerators = Object.fromEntries(SHORTCUT_IDS.map((id) => [id, ''])) as ShortcutMap
  const errors: Partial<Record<ShortcutId, ShortcutError>> = {}
  const seen = new Map<string, ShortcutId>()
  for (const id of SHORTCUT_IDS) {
    const raw = map[id]
    if (raw === undefined || raw === '') continue
    const r = validateAccelerator(raw)
    if (!r.ok) {
      errors[id] = r.error
      continue
    }
    const key = r.accelerator.toLowerCase()
    const other = seen.get(key)
    if (other) {
      errors[id] = 'duplicate'
      continue
    }
    seen.set(key, id)
    accelerators[id] = r.accelerator
  }
  return { accelerators, errors }
}

/** Arabic text for a registration failure (`globalShortcut.register` returned false). */
export function conflictMessageAr(id: ShortcutId, accelerator: string): string {
  return `تعذّر حجز الاختصار ${accelerator} لـ«${SHORTCUT_LABEL_AR[id]}»: يستعمله برنامج آخر أو النظام. اختر اختصاراً مختلفاً.`
}
