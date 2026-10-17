import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutosave, type SaveState } from './autosave'

function make(text = 'abc') {
  const state: SaveState[] = []
  const save = vi.fn(async () => {})
  const cur = { text }
  const a = createAutosave({
    getText: () => cur.text,
    save,
    onState: (s) => state.push(s)
  })
  return { a, save, state, cur }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('autosave', () => {
  it('saves 5000ms after the last change (debounced)', async () => {
    const { a, save } = make()
    a.setDocument(7)
    a.markDirty()
    await vi.advanceTimersByTimeAsync(4000)
    a.markDirty()
    await vi.advanceTimersByTimeAsync(4999)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(7, 'abc')
  })

  it('flush saves immediately and cancels the timer', async () => {
    const { a, save, state } = make()
    a.setDocument(1)
    a.markDirty()
    await a.flush()
    expect(save).toHaveBeenCalledTimes(1)
    expect(state.at(-1)).toBe('saved')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush is a no-op when clean', async () => {
    const { a, save } = make()
    a.setDocument(1)
    await a.flush()
    expect(save).not.toHaveBeenCalled()
  })

  it('goes unsaved on failure and stays dirty', async () => {
    const { a, save, state } = make()
    save.mockRejectedValueOnce(new Error('x'))
    a.setDocument(1)
    a.markDirty()
    await a.flush()
    expect(state.at(-1)).toBe('unsaved')
    expect(a.isDirty()).toBe(true)
    await a.flush()
    expect(state.at(-1)).toBe('saved')
  })

  it('stays unsaved if edited while saving', async () => {
    const { a, save, state } = make()
    let release!: () => void
    save.mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
    a.setDocument(1)
    a.markDirty()
    const p = a.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.at(-1)).toBe('saving')
    a.markDirty()
    release()
    await p
    expect(state.at(-1)).toBe('unsaved')
  })

  it('ignores changes with no document', async () => {
    const { a, save } = make()
    a.markDirty()
    await vi.advanceTimersByTimeAsync(6000)
    expect(save).not.toHaveBeenCalled()
  })
})
