import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('electron-log/main', () => ({ default: { transports: { file: {}, console: {} } } }))

import { rotateLogFile } from './logger'

describe('rotateLogFile', () => {
  it('shifts .1..5 and drops the oldest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mizaj-log-'))
    const f = join(dir, 'a.log')
    writeFileSync(f, 'cur')
    for (let i = 1; i <= 5; i++) writeFileSync(`${f}.${i}`, `old${i}`)
    rotateLogFile(f, 5)
    expect(readFileSync(`${f}.1`, 'utf8')).toBe('cur')
    expect(readFileSync(`${f}.2`, 'utf8')).toBe('old1')
    expect(readFileSync(`${f}.5`, 'utf8')).toBe('old4')
    expect(existsSync(f)).toBe(false)
    expect(existsSync(`${f}.6`)).toBe(false)
  })
})

describe('log scrubbing', () => {
  it('never lets a registered secret through strings, Errors or nested objects', async () => {
    const { registerSecret, scrubValue } = await import('./logger')
    const tok = 'f0'.repeat(32)
    registerSecret(tok)
    expect(scrubValue(`header ${tok}`)).not.toContain(tok)
    const e = scrubValue(new Error(`boom ${tok}`)) as Error
    expect(e.message).not.toContain(tok)
    expect(e.stack).not.toContain(tok)
    expect(JSON.stringify(scrubValue({ a: [{ b: `x${tok}` }] }))).not.toContain(tok)
    expect(scrubValue(42)).toBe(42)
  })
})
