import { describe, expect, it } from 'vitest'
import {
  buildCsp,
  generateApiToken,
  isAllowedExternalUrl,
  isAppUrl,
  isPermissionAllowed,
  PathAllowlist,
  scrubSecrets
} from './security'

describe('api token', () => {
  it('is 32 random bytes as 64 hex chars and differs per call', () => {
    const a = generateApiToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(generateApiToken()).not.toBe(a)
  })
})

describe('scrubSecrets', () => {
  const tok = 'ab'.repeat(32)
  it('removes the exact secret, header and env forms', () => {
    expect(scrubSecrets(`token is ${tok}!`, [tok])).not.toContain(tok)
    expect(scrubSecrets(`X-Mizaj-Token: ${tok}`)).toBe('X-Mizaj-Token: <redacted>')
    expect(scrubSecrets(`MIZAJ_API_TOKEN=${tok} x`)).toBe('MIZAJ_API_TOKEN=<redacted> x')
    expect(scrubSecrets(`{"x-mizaj-token":"${tok}"}`)).not.toContain(tok)
  })
  it('anyHex removes any 64-hex run; default keeps hashes in logs', () => {
    const h = 'c0ffee'.repeat(10) + 'abcd'
    expect(scrubSecrets(`sha ${h}`)).toContain(h)
    expect(scrubSecrets(`sha ${h}`, [], true)).not.toContain(h)
  })
})

describe('CSP', () => {
  it('is strict: no eval, no remote scripts, no framing, no plugins', () => {
    const csp = buildCsp()
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toMatch(/unsafe-eval/)
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:*;")
    expect(csp).toContain("img-src 'self' data: blob:")
    expect(csp).toContain("media-src 'self' blob:")
    expect(buildCsp({ dev: true })).toContain('ws://localhost:*')
  })
})

describe('isAppUrl', () => {
  const file = {
    rendererUrl: null,
    indexHtmlPath: '/opt/Mizaj/resources/app.asar/out/renderer/index.html'
  }
  it('accepts only the exact packaged index.html (hash/query ignored)', () => {
    expect(isAppUrl('file:///opt/Mizaj/resources/app.asar/out/renderer/index.html', file)).toBe(
      true
    )
    expect(
      isAppUrl('file:///opt/Mizaj/resources/app.asar/out/renderer/index.html#/x?y=1', file)
    ).toBe(true)
    expect(isAppUrl('file:///etc/passwd', file)).toBe(false)
    expect(isAppUrl('file:///opt/Mizaj/resources/app.asar/out/renderer/other.html', file)).toBe(
      false
    )
    expect(isAppUrl('https://evil.example/', file)).toBe(false)
    expect(isAppUrl('http://127.0.0.1:1234/', file)).toBe(false)
    expect(isAppUrl('about:blank', file)).toBe(false)
    expect(isAppUrl('', file)).toBe(false)
    expect(isAppUrl(undefined, file)).toBe(false)
    expect(
      isAppUrl('file://evil-host/opt/Mizaj/resources/app.asar/out/renderer/index.html', file)
    ).toBe(false)
  })
  it('dev: only the dev-server origin', () => {
    const dev = { rendererUrl: 'http://localhost:5173/', indexHtmlPath: '/x/index.html' }
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5173/src/main.ts', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('http://localhost.evil.com:5173/', dev)).toBe(false)
    expect(isAppUrl('file:///x/index.html', dev)).toBe(false)
  })
  it('windows paths compare case-insensitively', () => {
    const w = {
      rendererUrl: null,
      indexHtmlPath: '/C:/App/out/renderer/index.html',
      platform: 'win32' as const
    }
    expect(isAppUrl('file:///c:/app/out/renderer/index.html', w)).toBe(true)
    const real = { ...w, indexHtmlPath: 'C:\\Program Files\\Mizaj\\out\\renderer\\index.html' }
    expect(isAppUrl('file:///C:/Program%20Files/Mizaj/out/renderer/index.html', real)).toBe(true)
    expect(isAppUrl('file:///C:/Program%20Files/Mizaj/out/renderer/x.html', real)).toBe(false)
  })
})

describe('isAllowedExternalUrl', () => {
  it('allows https on allowlisted hosts and their subdomains', () => {
    for (const u of [
      'https://tanzil.net/download/',
      'https://github.com/UB-Mannheim/tesseract/wiki',
      'https://learn.microsoft.com/en-us/x',
      'https://tesseract-ocr.github.io/tessdoc/',
      'https://aistudio.google.com/apikey',
      'https://languagetool.org/download/',
      'https://creativecommons.org/publicdomain/zero/1.0/'
    ])
      expect(isAllowedExternalUrl(u), u).toBe(true)
  })
  it('rejects everything else', () => {
    for (const u of [
      'http://tanzil.net',
      'https://evil.example/',
      'https://tanzil.net.evil.example/',
      'https://eviltanzil.net/',
      'https://user:pw@github.com/',
      'https://github.com:8443/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ms-msdt:/id',
      'smb://host/share',
      '',
      'https://github.com/' + 'a'.repeat(3000)
    ])
      expect(isAllowedExternalUrl(u), u).toBe(false)
    expect(isAllowedExternalUrl(null)).toBe(false)
    expect(isAllowedExternalUrl({})).toBe(false)
  })
})

describe('PathAllowlist', () => {
  it('only knows dialog-returned paths, expires them and is bounded', () => {
    let t = 0
    const a = new PathAllowlist(1000, 3, () => t, false)
    a.add('/a')
    expect(a.has('/a')).toBe(true)
    expect(a.has('/b')).toBe(false)
    expect(a.has(5)).toBe(false)
    t = 1001
    expect(a.has('/a')).toBe(false)
    for (const p of ['/1', '/2', '/3', '/4']) a.add(p)
    expect(a.has('/1')).toBe(false)
    expect(a.has('/4')).toBe(true)
  })
})

describe('isPermissionAllowed', () => {
  const loc = {
    rendererUrl: null,
    indexHtmlPath: '/opt/Mizaj/resources/app.asar/out/renderer/index.html'
  }
  const page = 'file:///opt/Mizaj/resources/app.asar/out/renderer/index.html'
  it('allows only clipboard writes from the app page (copy buttons must work)', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', page, loc)).toBe(true)
    expect(isPermissionAllowed('clipboard-read', page, loc)).toBe(false)
    expect(isPermissionAllowed('media', page, loc)).toBe(false)
    expect(isPermissionAllowed('notifications', page, loc)).toBe(false)
    expect(isPermissionAllowed('clipboard-sanitized-write', 'https://evil.example/', loc)).toBe(
      false
    )
  })
})
