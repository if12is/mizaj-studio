import { ref } from 'vue'
import { notify } from '@renderer/api/toast'
import { NO_VOICE_MESSAGE, pickLocalArabicVoice, splitForSpeech } from '@renderer/tts/speech'

/** Offline read-aloud via the Web Speech API, local voices only (7.5.2). */
export function useTts() {
  const speaking = ref(false)

  async function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
    let v = synth.getVoices()
    if (v.length) return v
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000)
      synth.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(t)
          resolve()
        },
        { once: true }
      )
    })
    v = synth.getVoices()
    return v
  }

  function stop(): void {
    window.speechSynthesis?.cancel()
    speaking.value = false
  }

  async function toggle(text: string): Promise<void> {
    if (speaking.value) return stop()
    const synth = window.speechSynthesis
    if (!synth) return notify(NO_VOICE_MESSAGE, { kind: 'info', ms: 9000 })
    const voice = pickLocalArabicVoice(await loadVoices(synth))
    if (!voice) return notify(NO_VOICE_MESSAGE, { kind: 'info', ms: 9000 })
    const parts = splitForSpeech(text)
    if (!parts.length) return
    speaking.value = true
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p)
      u.voice = voice
      u.lang = voice.lang
      if (i === parts.length - 1) u.onend = () => (speaking.value = false)
      u.onerror = () => (speaking.value = false)
      synth.speak(u)
    })
  }

  return { speaking, toggle, stop }
}
