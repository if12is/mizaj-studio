import { describe, expect, it } from 'vitest'
import { NO_VOICE_MESSAGE, pickLocalArabicVoice, splitForSpeech } from './speech'

describe('offline TTS voice selection', () => {
  const v = (name: string, lang: string, localService: boolean, def = false) => ({
    name,
    lang,
    localService,
    default: def
  })
  it('never picks a cloud voice', () => {
    expect(pickLocalArabicVoice([v('Google Arabic', 'ar-SA', false)])).toBeNull()
  })
  it('prefers a local default Arabic voice, else the first local one', () => {
    const list = [v('en', 'en-US', true), v('Naayf', 'ar-SA', true), v('Hoda', 'ar-EG', true, true)]
    expect(pickLocalArabicVoice(list)?.name).toBe('Hoda')
    expect(pickLocalArabicVoice(list.slice(0, 2))?.name).toBe('Naayf')
  })
  it('matches ar, ar-XX and ar_XX only', () => {
    expect(pickLocalArabicVoice([v('a', 'ar', true)])).not.toBeNull()
    expect(pickLocalArabicVoice([v('a', 'ar_EG', true)])).not.toBeNull()
    expect(pickLocalArabicVoice([v('a', 'arn-CL', true)])).toBeNull()
    expect(NO_VOICE_MESSAGE).toContain('صوت عربي محلي')
  })
})

describe('splitForSpeech', () => {
  it('splits on sentences and paragraphs within the limit', () => {
    const parts = splitForSpeech('الجملة الأولى. الجملة الثانية؟\nفقرة جديدة هنا.', 20)
    expect(parts.every((p) => p.length <= 40)).toBe(true)
    expect(parts.join(' ')).toContain('فقرة جديدة هنا.')
  })
  it('cuts long unpunctuated text at spaces and skips blanks', () => {
    const parts = splitForSpeech('كلمة '.repeat(200) + '\n\n   \n', 100)
    expect(parts.length).toBeGreaterThan(5)
    expect(parts.every((p) => p.length <= 100)).toBe(true)
  })
})
