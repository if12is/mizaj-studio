import { describe, expect, it } from 'vitest'
import { ApiError } from '@renderer/api/client'
import { formatBytes, jobActive, jobPercent, onlineErrorText } from './helpers'

describe('online helpers', () => {
  it('formats sizes', () => {
    expect(formatBytes(null)).toBe('غير معروف')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(72109998)).toBe('68.8 MB')
  })
  it('computes job progress', () => {
    expect(jobPercent(null)).toBeNull()
    expect(jobPercent({ bytes_done: 5, bytes_total: null })).toBeNull()
    expect(jobPercent({ bytes_done: 50, bytes_total: 200 })).toBe(25)
  })
  it('knows active jobs', () => {
    expect(jobActive(null)).toBe(false)
    expect(jobActive({ id: 'a', status: 'running', bytes_done: 0, bytes_total: null })).toBe(true)
    expect(jobActive({ id: 'a', status: 'done', bytes_done: 0, bytes_total: null })).toBe(false)
  })
  it('maps online errors to Arabic', () => {
    expect(onlineErrorText(new ApiError(403, 'ERR_ONLINE_DISABLED', 'x', ''))).toContain('معطّلة')
    expect(onlineErrorText(new ApiError(409, 'ERR_LICENSE_NOT_ACCEPTED', 'x', ''))).toContain(
      'الترخيص'
    )
    expect(onlineErrorText(new ApiError(500, 'E', 'رسالة', ''))).toBe('رسالة')
  })
})
