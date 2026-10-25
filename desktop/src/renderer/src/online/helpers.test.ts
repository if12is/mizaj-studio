import { describe, expect, it } from 'vitest'
import { ApiError } from '@renderer/api/client'
import {
  arDigits,
  formatBytes,
  jobActive,
  jobPercent,
  onlineErrorText,
  quranErrText,
  resourceState,
  type ResourceJob
} from './helpers'

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

describe('quranErrText', () => {
  it('is always Arabic and actionable', () => {
    const dl = new ApiError(
      502,
      'ERR_QURAN_DOWNLOAD',
      'تعذر الاتصال بموقع Tanzil',
      'Quran download failed.'
    )
    expect(quranErrText(dl)).toBe('تعذر الاتصال بموقع Tanzil')
    expect(quranErrText(new ApiError(403, 'ERR_ONLINE_DISABLED', 'x', ''))).toContain('معطّل')
    expect(quranErrText(new ApiError(500, 'ERR_UNKNOWN', '', 'HTTP 500'))).toContain('المحرك')
    expect(quranErrText(new TypeError('Failed to fetch'))).not.toMatch(/[A-Za-z]/)
  })
})

describe('resourceState (one label, colour and icon per state)', () => {
  const job = (o: Partial<ResourceJob>): ResourceJob => ({
    id: 'j',
    status: 'running',
    bytes_done: 0,
    bytes_total: null,
    ...o
  })
  const inst = { path: 'p', sha256: 's', source: 'download' }

  it('not installed', () => {
    const s = resourceState({ installed: null, job: null })
    expect(s).toMatchObject({ state: 'missing', label: 'غير مثبّت', bg: 'bg-slate-600' })
  })
  it('downloading shows Arabic-digit percent, unknown size has no number', () => {
    const s = resourceState({
      installed: null,
      job: job({ bytes_done: 45, bytes_total: 100, phase: 'downloading' })
    })
    expect(s).toMatchObject({ state: 'downloading', label: 'جارٍ التنزيل… ٤٥٪' })
    expect(resourceState({ installed: null, job: job({}) }).label).toBe('جارٍ التنزيل…')
    expect(arDigits(1203)).toBe('١٢٠٣')
  })
  it('installing while the archive is unpacked', () => {
    const s = resourceState({ installed: null, job: job({ phase: 'installing' }) })
    expect(s).toMatchObject({ state: 'installing', label: 'جارٍ التثبيت…' })
  })
  it('installed and enabled is green, installed but off is amber', () => {
    expect(resourceState({ installed: inst, enabled: true, job: null })).toMatchObject({
      state: 'enabled',
      label: 'مثبّت ومفعّل ✓',
      bg: 'bg-emerald-700'
    })
    expect(resourceState({ installed: inst, job: null }).state).toBe('enabled') // legacy: no flag
    expect(resourceState({ installed: inst, enabled: false, job: null })).toMatchObject({
      state: 'disabled',
      label: 'مثبّت — غير مفعّل',
      bg: 'bg-amber-700'
    })
  })
  it('failed or interrupted downloads are red errors with the message', () => {
    const failed = job({ status: 'failed', error: { message_ar: 'انقطع الاتصال' } })
    expect(resourceState({ installed: null, job: failed })).toMatchObject({
      state: 'error',
      label: 'خطأ: انقطع الاتصال',
      bg: 'bg-red-700'
    })
    expect(resourceState({ installed: null, job: job({ status: 'paused' }) }).label).toBe(
      'خطأ: انقطع التنزيل'
    )
  })
  it('an installed resource stays installed when a later update attempt failed', () => {
    const s = resourceState({ installed: inst, enabled: true, job: job({ status: 'failed' }) })
    expect(s.state).toBe('enabled')
  })
  it('a finished job without install files falls back to not installed (never "enabled")', () => {
    expect(resourceState({ installed: null, job: job({ status: 'done' }) }).state).toBe('missing')
    expect(resourceState({ installed: null, job: job({ status: 'cancelled' }) }).state).toBe(
      'missing'
    )
  })
  it('every state has a tooltip and a distinct label', () => {
    const all = [
      resourceState({ installed: null, job: null }),
      resourceState({ installed: null, job: job({}) }),
      resourceState({ installed: null, job: job({ phase: 'installing' }) }),
      resourceState({ installed: inst, enabled: true, job: null }),
      resourceState({ installed: inst, enabled: false, job: null }),
      resourceState({ installed: null, job: job({ status: 'failed' }) })
    ]
    for (const s of all) expect(s.tip.length).toBeGreaterThan(10)
    expect(new Set(all.map((s) => s.state)).size).toBe(6)
    expect(new Set(all.map((s) => s.icon)).size).toBe(6)
  })
})
