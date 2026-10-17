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
