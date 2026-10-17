import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: {}
}))

import { cleanExtensions, isSafeExternalUrl, sanitizeFileName } from './fileIpc'

describe('file IPC helpers', () => {
  it('sanitizes file names', () => {
    expect(sanitizeFileName('a/b:c*.txt')).toBe('a_b_c_.txt')
    expect(sanitizeFileName('  ')).toBe('mizaj')
    expect(sanitizeFileName(5)).toBe('mizaj')
  })
  it('only allows plain https links', () => {
    expect(isSafeExternalUrl('https://tanzil.net/download/')).toBe(true)
    expect(isSafeExternalUrl('http://tanzil.net')).toBe(false)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('https://user:pw@evil.example')).toBe(false)
    expect(isSafeExternalUrl(null)).toBe(false)
  })
  it('keeps only simple extensions', () => {
    expect(cleanExtensions(['TXT', 'a/b', 'md', 5])).toEqual(['txt', 'md'])
    expect(cleanExtensions('x')).toEqual([])
  })
})
