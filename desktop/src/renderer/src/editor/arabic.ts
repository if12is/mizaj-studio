/* eslint-disable no-misleading-character-class -- combining marks are intentionally ranges */
/** Arabic text helpers shared by the editor extensions (pure, no DOM). */

export const FATHA = 'َ'
export const DAMMA = 'ُ'
export const KASRA = 'ِ'
export const FATHATAN = 'ً'
export const DAMMATAN = 'ٌ'
export const KASRATAN = 'ٍ'
export const SUKUN = 'ْ'
export const SHADDA = 'ّ'

/** Combining marks: U+064B-U+0652 and superscript alef U+0670. */
export const MARK_CLASS = '\\u064B-\\u0652\\u0670'
const LETTER_CLASS = '\\u0621-\\u063A\\u0641-\\u064A\\u0671-\\u06D3'

const MARKS_RE = new RegExp(`[${MARK_CLASS}]`, 'g')
export const WORD_RE = new RegExp(`[${LETTER_CLASS}${MARK_CLASS}]+`, 'g')

export function isMark(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return (c >= 0x064b && c <= 0x0652) || c === 0x0670
}

export function isArabicLetter(ch: string): boolean {
  const c = ch.charCodeAt(0)
  return (
    (c >= 0x0621 && c <= 0x063a) || (c >= 0x0641 && c <= 0x064a) || (c >= 0x0671 && c <= 0x06d3)
  )
}

export function isWordChar(ch: string): boolean {
  return isArabicLetter(ch) || isMark(ch)
}

export function stripMarks(s: string): string {
  return s.replace(MARKS_RE, '')
}

export function hasArabic(s: string): boolean {
  return new RegExp(`[${LETTER_CLASS}]`).test(s)
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g)
  return m ? m.length : 0
}

export interface TextLike {
  lineAt(pos: number): { from: number; to: number; text: string }
}

/** Word bounds (letters + marks) touching `pos`, or null when not on a word. */
export function wordBoundsAt(doc: TextLike, pos: number): { from: number; to: number } | null {
  const line = doc.lineAt(pos)
  const text = line.text
  const i = pos - line.from
  let a = i
  let b = i
  while (a > 0 && isWordChar(text[a - 1])) a--
  while (b < text.length && isWordChar(text[b])) b++
  if (a === b) return null
  if (!hasArabic(text.slice(a, b))) return null
  return { from: line.from + a, to: line.from + b }
}

export interface Density {
  letters: number
  withMarks: number
  /** percentage 0..100 of Arabic letters carrying at least one mark */
  density: number
}

export function computeDensity(text: string): Density {
  let letters = 0
  let withMarks = 0
  let prevLetter = false
  let counted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (isMark(ch)) {
      if (prevLetter && !counted) {
        withMarks++
        counted = true
      }
    } else if (isArabicLetter(ch)) {
      letters++
      prevLetter = true
      counted = false
    } else {
      prevLetter = false
      counted = false
    }
  }
  return { letters, withMarks, density: letters ? (withMarks / letters) * 100 : 0 }
}

export interface LetterSlot {
  /** index of the base letter inside the word string */
  index: number
  letter: string
  marks: string
}

/** Arabic base letters of a word with the marks that follow each. */
export function letterSlots(word: string): LetterSlot[] {
  const out: LetterSlot[] = []
  for (let i = 0; i < word.length; i++) {
    if (!isArabicLetter(word[i])) continue
    let j = i + 1
    while (j < word.length && isMark(word[j])) j++
    out.push({ index: i, letter: word[i], marks: word.slice(i + 1, j) })
  }
  return out
}

export type HarakaKey =
  | 'fatha'
  | 'damma'
  | 'kasra'
  | 'fathatan'
  | 'dammatan'
  | 'kasratan'
  | 'sukun'
  | 'shadda'
  | 'clear'

export const HARAKAT: { key: HarakaKey; mark: string }[] = [
  { key: 'fatha', mark: FATHA },
  { key: 'damma', mark: DAMMA },
  { key: 'kasra', mark: KASRA },
  { key: 'fathatan', mark: FATHATAN },
  { key: 'dammatan', mark: DAMMATAN },
  { key: 'kasratan', mark: KASRATAN },
  { key: 'sukun', mark: SUKUN },
  { key: 'shadda', mark: SHADDA }
]

/** New marks block for one letter after pressing a palette key. */
export function applyHaraka(current: string, key: HarakaKey): string {
  if (key === 'clear') return ''
  const hasShadda = current.includes(SHADDA)
  if (key === 'shadda') {
    const rest = current.replace(SHADDA, '')
    return hasShadda ? rest : SHADDA + rest
  }
  const mark = HARAKAT.find((h) => h.key === key)?.mark ?? ''
  return (hasShadda ? SHADDA : '') + mark
}

/** Replace the marks of the `letterIdx`-th Arabic letter of `word`. */
export function setLetterMarks(word: string, letterIdx: number, marks: string): string {
  const slot = letterSlots(word)[letterIdx]
  if (!slot) return word
  return word.slice(0, slot.index + 1) + marks + word.slice(slot.index + 1 + slot.marks.length)
}
