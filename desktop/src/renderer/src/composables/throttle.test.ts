import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createThrottle } from './throttle'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createThrottle', () => {
  it('still fires while triggers keep arriving (no starvation)', () => {
    const fn = vi.fn()
    const t = createThrottle(fn, 400)
    for (let i = 0; i < 30; i++) {
      t.trigger()
      vi.advanceTimersByTime(100)
    }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(7)
  })
  it('cancel prevents the call', () => {
    const fn = vi.fn()
    const t = createThrottle(fn, 400)
    t.trigger()
    t.cancel()
    vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
  })
})
