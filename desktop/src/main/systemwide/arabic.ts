/* eslint-disable no-misleading-character-class -- combining marks are intentionally ranges */
/** Tiny Arabic helpers for the system-wide feature (pure, main-process side). */

const MARKS_RE = /[ً-ْٰ]/g
const LETTER_RE = /[ء-غف-يٱ-ۓ]/

/** Tashkeel marks: U+064B-U+0652 and superscript alef U+0670. */
export function isMark(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return (c >= 0x064b && c <= 0x0652) || c === 0x0670
}

export function stripMarks(s: string): string {
  return s.replace(MARKS_RE, '')
}

export function hasArabic(s: string): boolean {
  return LETTER_RE.test(s)
}

/** Number of whitespace-separated words that contain at least one Arabic letter. */
export function countArabicWords(text: string): number {
  let n = 0
  for (const w of text.split(/\s+/)) if (w && LETTER_RE.test(w)) n++
  return n
}
