import { describe, expect, it, vi } from 'vitest'
import { PiperReader, type PlayableAudio, type ReaderDeps } from './piperReader'
import { clampLengthScale, needsDiacritics, splitSentences } from './speech'

function fakeAudio(): PlayableAudio & { played: boolean; paused: boolean; end(): void } {
  const a = {
    played: false,
    paused: false,
    onended: null as (() => void) | null,
    onerror: null as (() => void) | null,
    play: vi.fn(async () => {
      a.played = true
      a.paused = false
    }),
    pause: vi.fn(() => {
      a.paused = true
    }),
    dispose: vi.fn(),
    end: () => a.onended?.()
  }
  return a
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function setup(over: Partial<ReaderDeps> = {}) {
  const audios: ReturnType<typeof fakeAudio>[] = []
  const synthCalls: string[] = []
  const states: string[] = []
  const chunks: (string | null)[] = []
  const errors: [unknown, number][] = []
  const deps: ReaderDeps = {
    synth: async (t) => {
      synthCalls.push(t)
      return new Blob([t])
    },
    makeAudio: () => {
      const a = fakeAudio()
      audios.push(a)
      return a
    },
    onState: (s) => states.push(s),
    onChunk: (c) => chunks.push(c ? c.text : null),
    onError: (e, i) => errors.push([e, i]),
    ...over
  }
  return { r: new PiperReader(deps), audios, synthCalls, states, chunks, errors }
}

describe('splitSentences', () => {
  it('splits on sentence punctuation with offsets into the source', () => {
    const src = 'مرحبا بكم. كيف الحال؟\nبخير'
    const c = splitSentences(src)
    expect(c.map((x) => x.text)).toEqual(['مرحبا بكم.', 'كيف الحال؟', 'بخير'])
    for (const x of c) expect(src.slice(x.from, x.to)).toBe(x.text)
  })
  it('skips pieces without letters and cuts long sentences at spaces', () => {
    expect(splitSentences('... \n ؟؟')).toEqual([])
    const long = Array(80).fill('كلمة').join(' ')
    const c = splitSentences(long, 50)
    expect(c.length).toBeGreaterThan(5)
    expect(c.every((x) => x.text.length <= 50)).toBe(true)
  })
  it('helpers', () => {
    expect(needsDiacritics('كتاب')).toBe(true)
    expect(needsDiacritics('كِتَابٌ')).toBe(false)
    expect(needsDiacritics('abc')).toBe(false)
    expect(clampLengthScale('9')).toBe(2)
    expect(clampLengthScale('0.1')).toBe(0.5)
    expect(clampLengthScale('x')).toBe(1)
  })
})

describe('PiperReader', () => {
  const cs = [
    { text: 'أ', from: 0, to: 1 },
    { text: 'ب', from: 2, to: 3 },
    { text: 'ج', from: 4, to: 5 }
  ]
  it('prefetches the next sentence while the current one plays, then finishes', async () => {
    const { r, audios, synthCalls, states, chunks } = setup()
    void r.start(cs)
    await tick()
    expect(audios).toHaveLength(1)
    expect(synthCalls).toEqual(['أ', 'ب']) // second already requested during playback of first
    audios[0].end()
    await tick()
    expect(synthCalls).toEqual(['أ', 'ب', 'ج'])
    audios[1].end()
    await tick()
    audios[2].end()
    await tick()
    expect(states.at(-1)).toBe('idle')
    expect(chunks).toEqual(['أ', 'ب', 'ج', null])
  })
  it('pause / resume / stop act on the live audio', async () => {
    const { r, audios, states } = setup()
    void r.start(cs)
    await tick()
    expect(r.state).toBe('playing')
    r.pause()
    expect(r.state).toBe('paused')
    expect(audios[0].paused).toBe(true)
    r.resume()
    expect(r.state).toBe('playing')
    r.stop()
    expect(r.state).toBe('idle')
    expect(audios[0].dispose).toHaveBeenCalled()
    await tick()
    expect(audios).toHaveLength(1) // nothing more starts after stop
    expect(states.at(-1)).toBe('idle')
  })
  it('pause while a sentence is still being synthesized holds playback until resume', async () => {
    let release: (b: Blob) => void = () => undefined
    const { r, audios } = setup({ synth: () => new Promise<Blob>((res) => (release = res)) })
    void r.start(cs.slice(0, 1))
    await tick()
    r.pause()
    expect(r.state).toBe('paused')
    release(new Blob(['x']))
    await tick()
    expect(audios).toHaveLength(0)
    r.resume()
    await tick()
    expect(audios).toHaveLength(1)
    expect(r.state).toBe('playing')
  })
  it('reports a synthesis error with the failing index and stops', async () => {
    let n = 0
    const { r, errors, audios } = setup({
      synth: async () => {
        if (n++ === 1) throw new Error('boom')
        return new Blob(['x'])
      }
    })
    void r.start(cs)
    await tick()
    audios[0].end()
    await tick()
    expect(errors).toHaveLength(1)
    expect(errors[0][1]).toBe(1)
    expect(r.state).toBe('idle')
  })
  it('a failing first sentence reports index 0 and plays nothing', async () => {
    const { r, errors, audios } = setup({
      synth: async () => {
        throw new Error('x')
      }
    })
    await r.start(cs)
    expect(errors[0][1]).toBe(0)
    expect(audios).toHaveLength(0)
  })
})
