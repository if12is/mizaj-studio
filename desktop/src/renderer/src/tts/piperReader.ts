import type { SpeechChunk } from './speech'

export type ReaderState = 'idle' | 'loading' | 'playing' | 'paused'

export interface PlayableAudio {
  play(): Promise<void>
  pause(): void
  /** set before play(); called when playback finished */
  onended: (() => void) | null
  onerror: (() => void) | null
  dispose(): void
}

export interface ReaderDeps {
  /** WAV for one chunk; must reject on failure and honour `signal` */
  synth(text: string, signal: AbortSignal): Promise<Blob>
  makeAudio(blob: Blob): PlayableAudio
  onState(s: ReaderState): void
  /** the chunk now being spoken (null when done / stopped) */
  onChunk(c: SpeechChunk | null): void
  /** synthesis or playback failed at chunk `index`; reading stopped there */
  onError(err: unknown, index: number): void
}

/**
 * Sentence-by-sentence player: the first sentence is synthesized, then while it plays the next
 * one is already being synthesized (prefetch depth 1). Pause/resume/stop act on the live audio.
 */
export class PiperReader {
  private token = 0
  private audio: PlayableAudio | null = null
  private ctrl: AbortController | null = null
  private _state: ReaderState = 'idle'

  constructor(private readonly d: ReaderDeps) {}

  get state(): ReaderState {
    return this._state
  }

  private set(s: ReaderState): void {
    this._state = s
    this.d.onState(s)
  }

  async start(chunks: SpeechChunk[]): Promise<void> {
    this.stop()
    if (!chunks.length) return
    const my = ++this.token
    const ctrl = new AbortController()
    this.ctrl = ctrl
    const pre = new Map<number, Promise<Blob>>()
    const get = (i: number): Promise<Blob> => {
      let p = pre.get(i)
      if (!p) {
        p = this.d.synth(chunks[i].text, ctrl.signal)
        p.catch(() => undefined) // surfaced when awaited; never an unhandled rejection
        pre.set(i, p)
      }
      return p
    }
    this.set('loading')
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) this.set('loading')
      let blob: Blob
      try {
        blob = await get(i)
      } catch (e) {
        if (my === this.token) {
          this.finish()
          this.d.onError(e, i)
        }
        return
      }
      if (my !== this.token) return
      if (i + 1 < chunks.length) void get(i + 1)
      // paused while this sentence was still being synthesized: wait for resume before playing
      while (this._state === 'paused' && my === this.token)
        await new Promise<void>((res) => (this.gate = res))
      if (my !== this.token) return
      const audio = this.d.makeAudio(blob)
      this.audio = audio
      this.d.onChunk(chunks[i])
      try {
        await new Promise<void>((resolve, reject) => {
          audio.onended = resolve
          audio.onerror = () => reject(new Error('audio'))
          audio
            .play()
            .then(() => {
              if (my === this.token && this._state !== 'paused') this.set('playing')
            })
            .catch(reject)
          this.resolveCurrent = resolve // stop() releases the wait
        })
      } catch (e) {
        audio.dispose()
        if (my === this.token) {
          this.finish()
          this.d.onError(e, i)
        }
        return
      }
      audio.dispose()
      if (my !== this.token) return
    }
    this.finish()
  }

  private gate: (() => void) | null = null
  private resolveCurrent: (() => void) | null = null

  private finish(): void {
    this.audio = null
    this.ctrl = null
    this.d.onChunk(null)
    this.set('idle')
  }

  pause(): void {
    if (this._state === 'loading') return this.set('paused')
    if (this._state !== 'playing' || !this.audio) return
    this.audio.pause()
    this.set('paused')
  }

  resume(): void {
    if (this._state !== 'paused') return
    if (!this.audio) {
      this.set('loading')
      this.gate?.()
      return
    }
    this.set('playing')
    void this.audio.play().catch(() => undefined)
  }

  stop(): void {
    if (this._state === 'idle' && !this.ctrl) return
    this.token++
    this.ctrl?.abort()
    const a = this.audio
    this.audio = null
    this.ctrl = null
    if (a) {
      a.onended = null
      a.onerror = null
      a.pause()
      a.dispose()
    }
    this.resolveCurrent?.()
    this.resolveCurrent = null
    this.gate?.()
    this.gate = null
    this.d.onChunk(null)
    this.set('idle')
  }
}
