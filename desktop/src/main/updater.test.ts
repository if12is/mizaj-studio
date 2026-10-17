import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  UpdaterController,
  type UpdaterLike,
  type UpdaterStatus
} from './updater'

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  logger: unknown = null
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update')
    return null
  })
  downloadUpdate = vi.fn(async () => [])
  quitAndInstall = vi.fn()
}

function make(opts: { isPackaged?: boolean; order?: string[] } = {}) {
  const updater = new FakeUpdater()
  const sent: UpdaterStatus[] = []
  const order = opts.order ?? []
  const ctl = new UpdaterController({
    updater,
    isPackaged: opts.isPackaged ?? true,
    send: (s) => sent.push(s),
    flushRenderer: async () => {
      order.push('flush')
    },
    stopSidecar: async () => {
      order.push('stop')
    }
  })
  updater.quitAndInstall.mockImplementation(() => order.push('quitAndInstall'))
  return { updater, sent, ctl, order }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('UpdaterController config', () => {
  it('disables auto download/install/downgrade', () => {
    const { updater } = make()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
  })
})

describe('scheduling', () => {
  it('checks 10s after start and every 6h when enabled', async () => {
    const { updater, ctl } = make()
    ctl.setAutoCheck(true)
    ctl.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    updater.emit('update-not-available')
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('toggle off: no automatic checks, manual check still works', async () => {
    const { updater, ctl } = make()
    ctl.setAutoCheck(false)
    ctl.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await ctl.check(true)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('no automatic check until the renderer pushed the setting; then catches up', async () => {
    const { updater, ctl } = make()
    ctl.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 1000)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    ctl.setAutoCheck(true)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('never schedules in development (not packaged)', async () => {
    const { updater, ctl, sent } = make({ isPackaged: false })
    ctl.setAutoCheck(true)
    ctl.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await ctl.check(true)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(sent.at(-1)).toEqual({ state: 'idle', code: 'not-packaged' })
  })
})

describe('event -> status mapping', () => {
  it('maps updater events to updater:status payloads', () => {
    const { updater, sent } = make()
    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '0.1.1' })
    updater.emit('download-progress', { percent: 41.6, bytesPerSecond: 1234 })
    updater.emit('update-downloaded', { version: '0.1.1' })
    updater.emit('update-not-available')
    expect(sent).toEqual([
      { state: 'checking' },
      { state: 'available', version: '0.1.1' },
      { state: 'downloading', version: '0.1.1', percent: 42, bytesPerSecond: 1234 },
      { state: 'downloaded', version: '0.1.1' },
      { state: 'not-available' }
    ])
  })

  it('manual check errors are surfaced; background errors are silent', async () => {
    const { updater, ctl, sent } = make()
    await ctl.check(true)
    updater.emit('error', new Error('offline'))
    expect(sent.at(-1)).toEqual({ state: 'error', message: 'offline' })

    const b = make()
    b.ctl.setAutoCheck(true)
    b.ctl.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    b.updater.emit('error', new Error('offline'))
    expect(b.sent.at(-1)).toEqual({ state: 'idle' })
  })

  it('download only after an update is available', async () => {
    const { updater, ctl } = make()
    await ctl.download()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    updater.emit('update-available', { version: '0.1.1' })
    await ctl.download()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('install sequence', () => {
  it('flush -> stop sidecar -> quitAndInstall(true, true) silently, in order', async () => {
    const order: string[] = []
    const { updater, ctl } = make({ order })
    await ctl.installNow()
    expect(updater.quitAndInstall).not.toHaveBeenCalled() // nothing downloaded yet
    updater.emit('update-downloaded', { version: '0.1.1' })
    await ctl.installNow()
    expect(order).toEqual(['flush', 'stop', 'quitAndInstall'])
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})
