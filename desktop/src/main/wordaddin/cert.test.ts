import { X509Certificate, createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CERT_VALID_DAYS,
  certThumbprint,
  generateCert,
  inspectCert,
  keyMatchesCert,
  pemToDer
} from './cert'

describe('self-signed localhost certificate', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const c = generateCert(now)
  const x = new X509Certificate(c.certPem)

  it('parses as X.509 and is self-signed with its own key', () => {
    expect(x.subject).toBe(x.issuer)
    expect(x.verify(createPublicKey(c.keyPem))).toBe(true)
    expect(keyMatchesCert(c.certPem, c.keyPem)).toBe(true)
  })
  it('is a leaf (CA:FALSE), never a CA', () => {
    expect(x.ca).toBe(false)
    expect(x.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']) // serverAuth only
    expect(inspectCert(c.certPem, now)?.isCa).toBe(false)
  })
  it('has the SAN Chromium needs: localhost, 127.0.0.1 and ::1', () => {
    expect(x.checkHost('localhost')).toBe('localhost')
    expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1')
    expect(x.checkIP('::1')).toBeDefined()
    expect(x.checkHost('example.com')).toBeUndefined()
    expect(x.subjectAltName).toContain('DNS:localhost')
  })
  it('is valid for 730 days, starting a few minutes in the past', () => {
    const from = new Date(x.validFrom).getTime()
    const to = new Date(x.validTo).getTime()
    expect(from).toBeLessThanOrEqual(now.getTime())
    expect(Math.round((to - now.getTime()) / 86_400_000)).toBe(CERT_VALID_DAYS)
  })
  it('thumbprint is the SHA-1 of the DER in upper-case hex (what certutil uses)', () => {
    expect(c.thumbprint).toMatch(/^[0-9A-F]{40}$/)
    expect(certThumbprint(pemToDer(c.certPem))).toBe(c.thumbprint)
    expect(inspectCert(c.certPem, now)?.thumbprint).toBe(c.thumbprint)
  })
  it('every generation is a fresh key and serial', () => {
    const d = generateCert(now)
    expect(d.thumbprint).not.toBe(c.thumbprint)
    expect(d.keyPem).not.toBe(c.keyPem)
    expect(keyMatchesCert(c.certPem, d.keyPem)).toBe(false)
  })
  it('flags renewal in the last 30 days and expiry', () => {
    expect(inspectCert(c.certPem, now)?.needsRenewal).toBe(false)
    const late = new Date(now.getTime() + (CERT_VALID_DAYS - 10) * 86_400_000)
    expect(inspectCert(c.certPem, late)?.needsRenewal).toBe(true)
    const dead = new Date(now.getTime() + (CERT_VALID_DAYS + 1) * 86_400_000)
    expect(inspectCert(c.certPem, dead)?.expired).toBe(true)
  })
  it('rejects garbage without throwing', () => {
    expect(inspectCert('not a cert')).toBeNull()
    expect(keyMatchesCert('x', 'y')).toBe(false)
  })
})
