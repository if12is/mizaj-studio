import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GeminiKeyStore, isPlausibleKey, maskKey, type SafeStorageLike } from './keyStore'

const KEY = 'AIzaSyDUMMYKEYFORTESTS1234567890abcd'

function fakeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('ENC1:' + Buffer.from(s).reverse().toString('base64')),
    decryptString: (b) => {
      const t = b.toString()
      if (!t.startsWith('ENC1:')) throw new Error('bad')
      return Buffer.from(t.slice(5), 'base64').reverse().toString()
    }
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-key-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('GeminiKeyStore', () => {
  it('stores the key encrypted (never plain text) and round-trips it', () => {
    const f = join(dir, 'k.bin')
    const s = new GeminiKeyStore(f, fakeStorage())
    expect(s.save(KEY)).toEqual({ ok: true })
    const raw = readFileSync(f)
    expect(raw.toString('utf8')).not.toContain(KEY)
    expect(raw.toString('latin1')).not.toContain('SyDUMMY')
    expect(s.load()).toBe(KEY)
    expect(s.has()).toBe(true)
  })
  it('only ever exposes a masked hint', () => {
    const s = new GeminiKeyStore(join(dir, 'k.bin'), fakeStorage())
    s.save(KEY)
    const hint = s.hint()!
    expect(hint).toBe(maskKey(KEY))
    expect(hint).not.toContain('SyDUMMY')
    expect(hint.endsWith('abcd')).toBe(true)
  })
  it('refuses to save without OS encryption and writes nothing', () => {
    const f = join(dir, 'k.bin')
    const s = new GeminiKeyStore(f, fakeStorage(false))
    expect(s.save(KEY)).toEqual({ ok: false, reason: 'unavailable' })
    expect(existsSync(f)).toBe(false)
    expect(s.load()).toBeNull()
  })
  it('rejects implausible keys and clears', () => {
    const f = join(dir, 'k.bin')
    const s = new GeminiKeyStore(f, fakeStorage())
    expect(s.save('short')).toEqual({ ok: false, reason: 'invalid' })
    expect(s.save('has space in it which is long enough')).toEqual({ ok: false, reason: 'invalid' })
    expect(isPlausibleKey(KEY)).toBe(true)
    s.save(KEY)
    s.clear()
    expect(s.load()).toBeNull()
  })
  it('returns null for a corrupt file instead of throwing', () => {
    const f = join(dir, 'k.bin')
    const s = new GeminiKeyStore(f, fakeStorage())
    s.save(KEY)
    const bad = new GeminiKeyStore(f, {
      ...fakeStorage(),
      decryptString: () => {
        throw new Error('x')
      }
    })
    expect(bad.load()).toBeNull()
  })
})
