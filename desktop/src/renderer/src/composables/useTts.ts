import { ref } from 'vue'
import { notify } from '@renderer/api/toast'
import { ApiError } from '@renderer/api/client'
import { useApi } from '@renderer/api'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  NO_VOICE_MESSAGE,
  PIPER_FALLBACK_NOTICE,
  clampLengthScale,
  needsDiacritics,
  pickLocalArabicVoice,
  splitForSpeech,
  splitSentences
} from '@renderer/tts/speech'
import { PiperReader, type PlayableAudio, type ReaderState } from '@renderer/tts/piperReader'

export interface ReadHooks {
  /** offset of `text` inside the document (selection start), for highlighting */
  offset?: number
  /** highlight a document range while it is read; null clears it */
  highlight?: (range: { from: number; to: number } | null) => void
}

interface PiperStatus {
  available: boolean
  engine_missing_after_install?: boolean
}

function htmlAudio(blob: Blob): PlayableAudio {
  const url = URL.createObjectURL(blob)
  const el = new Audio(url)
  let done = false
  const a: PlayableAudio = {
    onended: null,
    onerror: null,
    play: () => el.play(),
    pause: () => el.pause(),
    dispose: () => {
      if (done) return
      done = true
      el.removeAttribute('src')
      URL.revokeObjectURL(url)
    }
  }
  el.onended = () => a.onended?.()
  el.onerror = () => a.onerror?.()
  return a
}

/**
 * Read-aloud. Engines: the OS voice (Web Speech API, local voices only, 7.5.2) or Piper (local
 * neural voice, synthesized by the backend sentence by sentence). Piper failures fall back to
 * the system voice with a notice. Text is never logged.
 */
export function useTts() {
  const speaking = ref(false)
  const paused = ref(false)
  const engine = ref<'system' | 'piper'>('system')
  let hooks: ReadHooks = {}
  let source: { text: string; offset: number } = { text: '', offset: 0 }

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

  async function speakSystem(text: string): Promise<boolean> {
    const synth = window.speechSynthesis
    if (!synth) {
      notify(NO_VOICE_MESSAGE, { kind: 'info', ms: 9000 })
      return false
    }
    const voice = pickLocalArabicVoice(await loadVoices(synth))
    if (!voice) {
      notify(NO_VOICE_MESSAGE, { kind: 'info', ms: 9000 })
      return false
    }
    const parts = splitForSpeech(text)
    if (!parts.length) return false
    engine.value = 'system'
    speaking.value = true
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p)
      u.voice = voice
      u.lang = voice.lang
      if (i === parts.length - 1) u.onend = () => (speaking.value = false)
      u.onerror = () => (speaking.value = false)
      synth.speak(u)
    })
    return true
  }

  const settings = useSettingsStore()
  const reader = new PiperReader({
    async synth(text, signal) {
      let t = text
      if (settings.values.tts_diacritized !== 'false' && needsDiacritics(t)) {
        try {
          const r = await useApi().request<{ text: string }>(
            'POST',
            '/api/tashkeel',
            { text: t, mode: 'fast' },
            true
          )
          if (r?.text) t = r.text
        } catch {
          /* reading the plain text is better than not reading */
        }
      }
      return useApi().postBlob(
        '/api/tts/piper/synthesize',
        { text: t, length_scale: clampLengthScale(settings.values.tts_length_scale) },
        signal
      )
    },
    makeAudio: htmlAudio,
    onState(s: ReaderState) {
      speaking.value = s !== 'idle'
      paused.value = s === 'paused'
    },
    onChunk(c) {
      hooks.highlight?.(c ? { from: source.offset + c.from, to: source.offset + c.to } : null)
    },
    onError(err, index) {
      const msg =
        err instanceof ApiError && err.messageAr ? err.messageAr : 'تعذّر تشغيل صوت Piper.'
      notify(`${msg} ${PIPER_FALLBACK_NOTICE}`, { kind: 'info', ms: 9000 })
      const rest = splitSentences(source.text)
        .slice(index)
        .map((c) => c.text)
        .join('\n')
      void speakSystem(rest)
    }
  })

  async function piperAvailable(): Promise<boolean> {
    try {
      const st = await useApi().get<PiperStatus>('/api/tts/piper/status', true)
      if (st.available) return true
      notify(
        st.engine_missing_after_install
          ? 'ملف Piper غير موجود، ربما عزله Windows Defender. أعد تنزيله من الإعدادات. تمت القراءة بصوت النظام.'
          : 'صوت Piper غير مثبّت (الإعدادات ← الاتصال والموارد المجانية). تمت القراءة بصوت النظام.',
        { kind: 'info', ms: 9000 }
      )
    } catch {
      notify(PIPER_FALLBACK_NOTICE, { kind: 'info', ms: 9000 })
    }
    return false
  }

  function stop(): void {
    window.speechSynthesis?.cancel()
    reader.stop()
    speaking.value = false
    paused.value = false
    hooks.highlight?.(null)
  }

  function pause(): void {
    if (engine.value === 'piper') reader.pause()
    else if (speaking.value) {
      window.speechSynthesis?.pause()
      paused.value = true
    }
  }

  function resume(): void {
    if (engine.value === 'piper') reader.resume()
    else if (paused.value) {
      window.speechSynthesis?.resume()
      paused.value = false
    }
  }

  async function toggle(text: string, h: ReadHooks = {}): Promise<void> {
    if (speaking.value) return stop()
    hooks = h
    source = { text, offset: h.offset ?? 0 }
    if (settings.values.tts_engine === 'piper') {
      const chunks = splitSentences(text)
      if (!chunks.length) return
      if (await piperAvailable()) {
        engine.value = 'piper'
        speaking.value = true // immediately: the button shows «إيقاف» while the first sentence loads
        void reader.start(chunks)
        return
      }
    }
    await speakSystem(text)
  }

  return { speaking, paused, engine, toggle, stop, pause, resume }
}
