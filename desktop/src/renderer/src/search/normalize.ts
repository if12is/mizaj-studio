/**
 * Arabic-aware text normalisation for search/matching (command palette).
 * Diacritics (tashkeel, dagger alif, Quranic marks) and tatweel are removed; alef variants
 * collapse to bare alef, alef maqsura to ya, ta marbuta to ha. Latin text is lower-cased and
 * Arabic-Indic digits become ASCII digits. Display text is never changed: this is for matching only.
 */
const DIACRITICS = /[ً-ٰٟۖ-ۭ࣓-ࣿ]/g
const TATWEEL = /ـ/g
const ALEF_VARIANTS = /[آأإٱ]/g
const AR_DIGITS = /[٠-٩۰-۹]/g

export function normalizeArabic(input: string): string {
  return input
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(ALEF_VARIANTS, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(AR_DIGITS, (d) => String(d.charCodeAt(0) & 0xf))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}
