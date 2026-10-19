/** Offline read-aloud (7.5.2): only voices with localService === true are ever used. */
export interface VoiceLike {
  name: string
  lang: string
  localService: boolean
  default?: boolean
}

/** First local Arabic voice (cloud voices are never chosen: text would leave the device). */
export function pickLocalArabicVoice<T extends VoiceLike>(voices: T[]): T | null {
  const ar = voices.filter((v) => v.localService === true && /^ar([-_]|$)/i.test(v.lang))
  return ar.find((v) => v.default) ?? ar[0] ?? null
}

/** Split into utterance-sized pieces on sentence boundaries (engines choke on huge strings). */
export function splitForSpeech(text: string, maxLen = 220): string[] {
  const out: string[] = []
  for (const para of text.split(/\n+/)) {
    const t = para.trim()
    if (!t) continue
    let cur = ''
    for (const s of t.split(/(?<=[.!؟?؛;،,:])\s+/)) {
      if (cur && cur.length + s.length + 1 > maxLen) {
        out.push(cur)
        cur = ''
      }
      if (s.length > maxLen) {
        // no punctuation: cut at spaces
        for (const w of s.split(' ')) {
          if (cur && cur.length + w.length + 1 > maxLen) {
            out.push(cur)
            cur = ''
          }
          cur = cur ? cur + ' ' + w : w
        }
      } else cur = cur ? cur + ' ' + s : s
    }
    if (cur) out.push(cur)
  }
  return out
}

export const NO_VOICE_MESSAGE =
  'لا يوجد صوت عربي محلي مثبّت على هذا الجهاز. ثبّت حزمة اللغة العربية للنطق من إعدادات النظام (Windows: الإعدادات ← الوقت واللغة ← الكلام). لا تُستخدم الأصوات السحابية حفاظاً على الخصوصية.'

export interface SpeechChunk {
  text: string
  /** offsets of the chunk in the source text (for highlighting) */
  from: number
  to: number
}

/**
 * Sentence chunks WITH their offsets, for Piper: small pieces so the first sound starts fast.
 * Splits on sentence punctuation and line breaks; over-long sentences are cut at spaces.
 */
export function splitSentences(text: string, maxLen = 160): SpeechChunk[] {
  const out: SpeechChunk[] = []
  const re = /[^.!؟?؛;\n]+[.!؟?؛;]*/g
  let m: RegExpExecArray | null
  const push = (raw: string, base: number): void => {
    const lead = raw.length - raw.trimStart().length
    const t = raw.trim()
    if (!/[\p{L}\p{N}]/u.test(t)) return
    out.push({ text: t, from: base + lead, to: base + lead + t.length })
  }
  while ((m = re.exec(text))) {
    const seg = m[0]
    if (seg.length <= maxLen) {
      push(seg, m.index)
      continue
    }
    let start = 0
    while (start < seg.length) {
      let end = Math.min(seg.length, start + maxLen)
      if (end < seg.length) {
        const sp = seg.lastIndexOf(' ', end)
        if (sp > start) end = sp
      }
      push(seg.slice(start, end), m.index + start)
      start = end
    }
  }
  return out
}

/** Has at least one Arabic letter and no diacritic mark at all. */
export const needsDiacritics = (t: string): boolean => /[ء-ي]/.test(t) && !/[ً-ْٰ]/.test(t)

export const clampLengthScale = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 1
}

export const PIPER_FALLBACK_NOTICE = 'تعذّر صوت Piper، فتمت القراءة بصوت النظام.'
