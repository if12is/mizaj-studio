/**
 * Proofreading before tashkeel (the owner's order: 1 proofreading, 2 punctuation, 3 tashkeel).
 *
 * Pure helpers over the `/api/proofread` response: grouping by category, per-item decisions and
 * the verified edits that are applied to the editor. Nothing here changes text: base letters are
 * only ever edited for items the user accepted (AGENTS.md section 5).
 */
import type { VerifiedEdit } from '@renderer/editor/safeEdit'

export type ProofCategory = 'hamza' | 'spelling' | 'ya' | 'punctuation'
export type Decision = 'accept' | 'reject' | 'pending'
export type BeforeTashkeelMode = 'ask' | 'auto_punct' | 'off'
export type YaStyle = 'standard' | 'egyptian'

export const CATEGORY_ORDER: ProofCategory[] = ['hamza', 'spelling', 'ya', 'punctuation']
export const CATEGORY_LABELS: Record<ProofCategory, string> = {
  hamza: 'همزات',
  spelling: 'إملاء',
  ya: 'الياء',
  punctuation: 'ترقيم'
}

export const BEFORE_TASHKEEL_OPTIONS: [BeforeTashkeelMode, string][] = [
  ['ask', 'اسأل'],
  ['auto_punct', 'تلقائي للترقيم فقط'],
  ['off', 'إيقاف']
]
export const YA_STYLE_OPTIONS: [YaStyle, string][] = [
  ['standard', 'ي (فصحى قياسية)'],
  ['egyptian', 'ى (أسلوب مصري)']
]

export interface ProofItem {
  id: string
  start: number
  end: number
  /** UTF-16 offsets (CodeMirror positions) relative to the text that was sent */
  start16: number
  end16: number
  original: string
  replacement: string
  category: ProofCategory
  code: string
  reason_ar: string
  confidence: number
  alternatives?: string[]
  /** true for the ي/ى items that depend on the style setting */
  style?: boolean
}

export interface ProofResponse {
  items: ProofItem[]
  counts: Record<ProofCategory, number>
  truncated: boolean
  ya_style: YaStyle
}

export type ReviewResult = 'apply_run' | 'apply_only' | 'skip_run' | 'cancel'

export function normalizeMode(v: string | undefined): BeforeTashkeelMode {
  return v === 'auto_punct' || v === 'off' ? v : 'ask'
}
export function normalizeYaStyle(v: string | undefined): YaStyle {
  return v === 'egyptian' ? 'egyptian' : 'standard'
}

export interface ProofGroup {
  category: ProofCategory
  label: string
  items: ProofItem[]
}

/** Non-empty groups in the review order: همزات، إملاء، الياء، ترقيم. */
export function groupItems(items: readonly ProofItem[]): ProofGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    items: items.filter((i) => i.category === category)
  })).filter((g) => g.items.length > 0)
}

/** Set every item of one category to `d` («قبول الكل» / «رفض الكل» of a group). */
export function setGroup(
  decisions: Record<string, Decision>,
  items: readonly ProofItem[],
  category: ProofCategory,
  d: Decision
): Record<string, Decision> {
  const next = { ...decisions }
  for (const i of items) if (i.category === category) next[i.id] = d
  return next
}

export function countByDecision(
  items: readonly ProofItem[],
  decisions: Record<string, Decision>,
  d: Decision
): number {
  let n = 0
  for (const i of items) if ((decisions[i.id] ?? 'pending') === d) n++
  return n
}

/**
 * Edits for the accepted items only. `base` is the editor offset of the text that was sent
 * (the selection start, or 0); `overrides` holds a chosen alternative (إنّ instead of أنّ).
 */
export function acceptedEdits(
  items: readonly ProofItem[],
  decisions: Record<string, Decision>,
  base: number,
  overrides: Record<string, string> = {}
): VerifiedEdit[] {
  return items
    .filter((i) => decisions[i.id] === 'accept')
    .map((i) => ({
      from: base + i.start16,
      to: base + i.end16,
      expected: i.original,
      insert: overrides[i.id] ?? i.replacement
    }))
}

/** «تلقائي للترقيم فقط»: only punctuation items are ever applied without asking. */
export function autoEdits(items: readonly ProofItem[], base: number): VerifiedEdit[] {
  const dec: Record<string, Decision> = {}
  for (const i of items) if (i.category === 'punctuation') dec[i.id] = 'accept'
  return acceptedEdits(items, dec, base)
}

/** A few characters around an item so the user sees where it is. */
export function contextOf(
  text: string,
  it: Pick<ProofItem, 'start16' | 'end16'>,
  radius = 18
): { before: string; after: string } {
  const clean = (s: string): string => s.replace(/\s+/g, ' ')
  return {
    before: clean(text.slice(Math.max(0, it.start16 - radius), it.start16)),
    after: clean(text.slice(it.end16, it.end16 + radius))
  }
}

/** Make invisible differences visible (spaces, NBSP, tatweel) in the review list. */
export function showChars(s: string): string {
  if (s === '') return '(حذف)'
  return [...s]
    .map((c) => {
      if (c === ' ') return '␣'
      if (c === ' ') return '⍽'
      if (c === '\t') return '⇥'
      return c
    })
    .join('')
}
