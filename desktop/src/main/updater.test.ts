import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  FOCUS_MIN_GAP_MS,
  shouldCheckOnFocus,
  summarizeReleaseNotes,
  OFFLINE_POLL_MS,
  isRetryableUpdateError,
  UpdaterController,
  type UpdaterLike,
  type UpdaterStatus
} from './updater'

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  logger: unknown = null
  checkForUpdates = vi.fn(async (): Promise<unknown> => {
    this.emit('checking-for-update')
    return null
  })
  downloadUpdate = vi.fn(async (): Promise<unknown> => [])
  quitAndInstall = vi.fn()
}

function make(opts: { isPackaged?: boolean; portable?: boolean; order?: string[] } = {}) {
  const updater = new FakeUpdater()
  const sent: UpdaterStatus[] = []
  const order = opts.order ?? []
  const ctl = new UpdaterController({
    updater,
    isPackaged: opts.isPackaged ?? true,
    portable: opts.portable,
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
  it('checks 10s after start and every 4h when enabled', async () => {
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

describe('portable build', () => {
  it('never checks automatically and explains why on a manual check', async () => {
    const { updater, ctl, sent } = make({ portable: true })
    ctl.setAutoCheck(true)
    ctl.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await ctl.check(true)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(sent.at(-1)).toEqual({ state: 'idle', code: 'portable' })
  })
})

describe('resilient updates (8.4.1)', () => {
  const netErr = (m = 'net::ERR_INTERNET_DISCONNECTED') => new Error(m)
  function makeR(opts: { online?: { v: boolean }; wake?: { cb?: () => void } } = {}) {
    const updater = new FakeUpdater()
    const sent: UpdaterStatus[] = []
    const t = 1_000_000
    const online = opts.online ?? { v: true }
    const ctl = new UpdaterController({
      updater,
      isPackaged: true,
      send: (s) => sent.push(s),
      flushRenderer: async () => {},
      stopSidecar: async () => {},
      isOnline: () => online.v,
      subscribeWake: (cb) => {
        if (opts.wake) opts.wake.cb = cb
        return () => {}
      },
      now: () => t
    })
    return { updater, ctl, sent, online }
  }

  it('classifies errors', () => {
    expect(isRetryableUpdateError(netErr())).toBe(true)
    expect(isRetryableUpdateError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isRetryableUpdateError(Object.assign(new Error('x'), { statusCode: 503 }))).toBe(true)
    expect(isRetryableUpdateError(Object.assign(new Error('x'), { statusCode: 404 }))).toBe(false)
    expect(isRetryableUpdateError(new Error('sha512 checksum mismatch, expected a, got b'))).toBe(
      true
    )
    expect(isRetryableUpdateError(new Error('Cannot parse latest.yml'))).toBe(false)
    expect(
      isRetryableUpdateError(
        new Error(
          'Cannot find channel: HttpError: 404 Not Found\nHeaders: {"keep-alive": "timeout=5"}'
        )
      )
    ).toBe(false)
    expect(isRetryableUpdateError(null)).toBe(false)
  })

  it('background check failure: silent idle, then 30 s / 2 min / 10 min backoff, no UI spam', async () => {
    const { updater, ctl, sent } = makeR()
    ctl.setAutoCheck(true)
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('checking-for-update')
      updater.emit('error', netErr())
      throw netErr()
    })
    ctl.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(sent.some((s) => s.state === 'retrying' || s.state === 'error')).toBe(false)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2) // +30 s
    await vi.advanceTimersByTimeAsync(120_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3) // +2 min
    await vi.advanceTimersByTimeAsync(600_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(4) // +10 min
    ctl.stop()
  })

  it('stops after 5 retries, then reports an error for a manual check', async () => {
    const { updater, ctl, sent } = makeR()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('error', netErr())
    })
    await ctl.check(true)
    expect(sent.at(-1)).toMatchObject({
      state: 'retrying',
      phase: 'check',
      attempt: 1,
      maxAttempts: 5
    })
    expect(typeof sent.at(-1)!.nextRetryAt).toBe('number')
    await vi.advanceTimersByTimeAsync(30_000 + 120_000 + 600_000 * 3)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(6) // first + 5 retries
    expect(sent.at(-1)!.state).toBe('error')
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(6) // no more
    // one 'retrying' status per scheduled retry, not per tick
    expect(sent.filter((s) => s.state === 'retrying')).toHaveLength(5)
  })

  it('a download interrupted by the network retries the download and finishes', async () => {
    const { updater, ctl, sent } = makeR()
    updater.emit('update-available', { version: '0.2.0' })
    let n = 0
    updater.downloadUpdate.mockImplementation(async () => {
      if (++n === 1) {
        updater.emit('download-progress', { percent: 40, bytesPerSecond: 1 })
        updater.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
        throw new Error('read ECONNRESET')
      }
      updater.emit('update-downloaded', { version: '0.2.0' })
    })
    await ctl.download()
    expect(sent.at(-1)).toMatchObject({
      state: 'retrying',
      phase: 'download',
      version: '0.2.0',
      percent: 40
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(sent.at(-1)).toMatchObject({ state: 'downloaded', version: '0.2.0' })
    expect(sent.filter((s) => s.state === 'error')).toHaveLength(0)
  })

  it('rejected promise without an error event is handled exactly once', async () => {
    const { updater, ctl, sent } = makeR()
    updater.emit('update-available', { version: '0.2.0' })
    updater.downloadUpdate.mockRejectedValueOnce(netErr('net::ERR_NETWORK_CHANGED'))
    await ctl.download()
    expect(sent.filter((s) => s.state === 'retrying')).toHaveLength(1)
  })

  it('waits while offline without burning attempts, resumes when back online', async () => {
    const online = { v: false }
    const { updater, ctl, sent } = makeR({ online })
    updater.emit('update-available', { version: '0.2.0' })
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('error', netErr())
    })
    await ctl.download()
    expect(sent.at(-1)).toMatchObject({
      state: 'retrying',
      offline: true,
      nextRetryAt: null,
      attempt: 0
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1) // still offline: no attempts
    online.v = true
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('update-downloaded', { version: '0.2.0' })
    })
    await vi.advanceTimersByTimeAsync(OFFLINE_POLL_MS)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(sent.at(-1)!.state).toBe('downloaded')
  })

  it('system resume retries immediately; manual check short-circuits the backoff', async () => {
    const wake: { cb?: () => void } = {}
    const { updater, ctl } = makeR({ wake })
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('error', netErr())
    })
    await ctl.check(true)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    wake.cb!()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('error', netErr())
    })
    updater.emit('error', netErr()) // back in backoff
    await ctl.check(true)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it('non-network errors are not retried', async () => {
    const { updater, ctl, sent } = makeR()
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('error', Object.assign(new Error('HttpError: 404'), { statusCode: 404 }))
    })
    await ctl.check(true)
    expect(sent.at(-1)).toMatchObject({ state: 'error' })
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('success clears the retry budget', async () => {
    const { updater, ctl, sent } = makeR()
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('error', netErr())
    })
    await ctl.check(true)
    await vi.advanceTimersByTimeAsync(30_000) // default mock emits 'checking-for-update' only
    updater.emit('update-not-available', {})
    expect(sent.at(-1)!.state).toBe('not-available')
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('error', netErr())
    })
    await ctl.check(true)
    expect(sent.at(-1)).toMatchObject({ state: 'retrying', attempt: 1 })
  })
})

describe('focus-triggered checks (throttle)', () => {
  it('shouldCheckOnFocus: first time, inside and outside the gap, clock going back', () => {
    expect(shouldCheckOnFocus(1000, null)).toBe(true)
    expect(shouldCheckOnFocus(1000 + FOCUS_MIN_GAP_MS - 1, 1000)).toBe(false)
    expect(shouldCheckOnFocus(1000 + FOCUS_MIN_GAP_MS, 1000)).toBe(true)
    expect(shouldCheckOnFocus(500, 1000)).toBe(true)
  })

  it('interval is 4h and the focus gap is at least 30 min', () => {
    expect(CHECK_INTERVAL_MS).toBe(4 * 60 * 60 * 1000)
    expect(FOCUS_MIN_GAP_MS).toBeGreaterThanOrEqual(30 * 60 * 1000)
  })

  it('focus before the startup delay does nothing', async () => {
    const { updater, ctl } = make()
    ctl.setAutoCheck(true)
    ctl.start()
    ctl.notifyFocus()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('focus checks once, then is throttled for 30 min, then checks again', async () => {
    const { updater, ctl } = make()
    ctl.setAutoCheck(true)
    ctl.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS) // first check at 10 s
    updater.emit('update-not-available')
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    ctl.notifyFocus() // 10 min after the last check: throttled
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FOCUS_MIN_GAP_MS)
    ctl.notifyFocus()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    updater.emit('update-not-available')
    ctl.notifyFocus() // immediately again: throttled
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('the 4h timer counts as a check for the throttle', async () => {
    const { updater, ctl } = make()
    ctl.setAutoCheck(true)
    ctl.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    updater.emit('update-not-available')
    const n = updater.checkForUpdates.mock.calls.length
    ctl.notifyFocus()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(n)
  })

  it('respects the opt-out, portable and development builds', async () => {
    for (const o of [{ portable: true }, { isPackaged: false }]) {
      const { updater, ctl } = make(o)
      ctl.setAutoCheck(true)
      ctl.start()
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
      ctl.notifyFocus()
      expect(updater.checkForUpdates).not.toHaveBeenCalled()
    }
    const { updater, ctl } = make()
    ctl.setAutoCheck(false)
    ctl.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    ctl.notifyFocus()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('does not re-check while an update is already available (no banner flicker)', async () => {
    const { updater, ctl } = make()
    ctl.setAutoCheck(true)
    ctl.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    updater.emit('update-available', { version: '9.9.9' })
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    ctl.notifyFocus()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('release notes summary', () => {
  it('strips HTML, joins note lists and truncates', () => {
    expect(summarizeReleaseNotes('<p>إصلاح &amp; تحسين</p><ul><li>أ</li><li>ب</li></ul>')).toBe(
      'إصلاح & تحسين\nأ\nب'
    )
    expect(summarizeReleaseNotes([{ note: 'one' }, { note: 'two' }])).toBe('one\ntwo')
    expect(summarizeReleaseNotes('x'.repeat(500), 10)).toBe('x'.repeat(10) + '…')
    expect(summarizeReleaseNotes(null)).toBeUndefined()
    expect(summarizeReleaseNotes('  <br/> ')).toBeUndefined()
  })

  it('carries the summary in the available status', () => {
    const { updater, sent } = make()
    updater.emit('update-available', { version: '1.2.3', releaseNotes: '<p>ميزة جديدة</p>' })
    expect(sent.at(-1)).toMatchObject({ state: 'available', version: '1.2.3', notes: 'ميزة جديدة' })
  })
})
