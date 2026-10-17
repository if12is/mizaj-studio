import { describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const listeners = new Map<string, (...a: unknown[]) => void>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, f: (...a: unknown[]) => unknown) => handlers.set(c, f),
    on: (c: string, f: (...a: unknown[]) => void) => listeners.set(c, f)
  }
}))

import { configureIpcGuard, handleSecure, isTrustedSender, onSecure } from './ipcGuard'

const warn = vi.fn()
configureIpcGuard({ rendererUrl: null, indexHtmlPath: '/app/out/renderer/index.html' }, warn)
const frame = (url: string, parent: unknown = null) => ({ senderFrame: { url, parent } }) as never

describe('ipc sender validation', () => {
  it('trusts only the top frame of the app page', () => {
    expect(isTrustedSender(frame('file:///app/out/renderer/index.html'))).toBe(true)
    expect(isTrustedSender(frame('https://evil.example/'))).toBe(false)
    expect(isTrustedSender(frame('file:///tmp/evil.html'))).toBe(false)
    expect(isTrustedSender(frame('file:///app/out/renderer/index.html', {}))).toBe(false) // sub-frame
    expect(isTrustedSender({ senderFrame: null } as never)).toBe(false)
  })

  it('handleSecure runs the handler for the app and throws for anyone else', () => {
    const fn = vi.fn(() => 'ok')
    handleSecure('x:do', fn)
    const h = handlers.get('x:do')!
    expect(h(frame('file:///app/out/renderer/index.html'), 1, 2)).toBe('ok')
    expect(fn).toHaveBeenCalledWith(expect.anything(), 1, 2)
    expect(() => h(frame('https://evil.example/'))).toThrow(/untrusted/)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'x:do'"))
  })

  it('onSecure silently drops messages from untrusted frames', () => {
    const fn = vi.fn()
    onSecure('x:ev', fn)
    const l = listeners.get('x:ev')!
    l(frame('https://evil.example/'))
    expect(fn).not.toHaveBeenCalled()
    l(frame('file:///app/out/renderer/index.html'))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
