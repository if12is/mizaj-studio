import { describe, expect, it } from 'vitest'
import { retryText } from './updateText'

describe('retryText', () => {
  it('counts down in minutes with attempt numbers', () => {
    expect(retryText({ attempt: 2, maxAttempts: 5, nextRetryAt: 120_000 }, 0)).toBe(
      'انقطع الاتصال — ستُعاد المحاولة خلال ٢ د (المحاولة ٢ من ٥)'
    )
  })
  it('counts down in seconds', () => {
    expect(retryText({ nextRetryAt: 30_000 }, 10_000)).toContain('٢٠ ث')
  })
  it('offline waits for the network', () => {
    expect(retryText({ offline: true, nextRetryAt: null }, 0)).toContain('عند عودة الاتصال')
  })
})
