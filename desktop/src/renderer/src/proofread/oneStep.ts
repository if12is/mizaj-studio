/**
 * «تدقيق وتشكيل» in one step: the policy for base-letter fixes and the single closing summary.
 * Pure helpers (no DOM, no stores). Base letters (hamza, spelling, ya) are suggestions, so by
 * default they still go through the review dialog; punctuation may always be applied directly.
 */
import { arDigits } from '@renderer/history/logic'
import type { ProofCategory, ProofItem } from './model'

/** Setting key: true = hamza/spelling/ya fixes are accepted automatically in this mode. */
export const AUTO_BASE_KEY = 'proofread_onestep_auto_base'

export const autoBaseEnabled = (v: string | undefined): boolean => v === 'true'

export type CategoryCounts = Record<ProofCategory, number>

export const emptyCounts = (): CategoryCounts => ({ hamza: 0, spelling: 0, ya: 0, punctuation: 0 })

export const isBase = (c: ProofCategory): boolean => c !== 'punctuation'

export function countCategories(items: readonly Pick<ProofItem, 'category'>[]): CategoryCounts {
  const out = emptyCounts()
  for (const i of items) out[i.category]++
  return out
}

/** Items applied without asking: all of them, or only punctuation (the default). */
export function autoAccepted<T extends Pick<ProofItem, 'category'>>(
  items: readonly T[],
  autoBase: boolean
): T[] {
  return items.filter((i) => autoBase || !isBase(i.category))
}

export interface OneStepSummary {
  fixed: CategoryCounts
  /** words that received marks in this run */
  words: number
  /** low-confidence words the run left for review */
  doubtful: number
}

const NOUNS: [ProofCategory, string][] = [
  ['hamza', 'همزة'],
  ['spelling', 'إملاء'],
  ['ya', 'ياء'],
  ['punctuation', 'ترقيم']
]

/** «صُحّح: ٤٥ همزة، ٥ إملاء، ٤١ ياء، ١٦٩ ترقيم — شُكّلت ٣٢٧٧ كلمة — مشكوك فيها: ٤٣» */
export function summaryLine(s: OneStepSummary): string {
  const fixed = NOUNS.filter(([c]) => s.fixed[c] > 0)
    .map(([c, n]) => `${arDigits(s.fixed[c])} ${n}`)
    .join('، ')
  return [
    fixed ? `صُحّح: ${fixed}` : 'لا تصحيحات',
    `شُكّلت ${arDigits(s.words)} كلمة`,
    `مشكوك فيها: ${arDigits(s.doubtful)}`
  ].join(' — ')
}

const MARK = /[ً-ْ]/
const WORD = /[ء-غـ-ْٰٱ]+/g

/** Arabic words that carry at least one mark. */
export function markedWords(text: string): number {
  let n = 0
  for (const m of text.matchAll(WORD)) if (MARK.test(m[0])) n++
  return n
}

/** Words that got marks between `before` (after proofreading) and `after` (the result). */
export function wordsDiacritized(before: string, after: string): number {
  return Math.max(0, markedWords(after) - markedWords(before))
}
