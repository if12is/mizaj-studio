import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CRASH_KEEP, cleanupUserData, restrictPermissions } from './userData'

describe('userData hygiene', () => {
  it('removes temp leftovers but never data, models or resumable .part files', () => {
    const d = mkdtempSync(join(tmpdir(), 'ud-clean-'))
    mkdirSync(join(d, 'tmp'))
    writeFileSync(join(d, 'tmp', 'x'), '1')
    writeFileSync(join(d, 'a.tmp'), '1')
    writeFileSync(join(d, '.~mizaj_tmp.docx'), '1')
    writeFileSync(join(d, 'mizaj.db'), 'keep')
    writeFileSync(join(d, 'dl.part'), 'keep')
    mkdirSync(join(d, 'models'))
    writeFileSync(join(d, 'models', 'm.onnx.part'), 'keep')
    const r = cleanupUserData(d)
    expect(r.removed.length).toBe(3)
    expect(existsSync(join(d, 'a.tmp'))).toBe(false)
    expect(existsSync(join(d, 'tmp', 'x'))).toBe(false)
    for (const k of ['mizaj.db', 'dl.part', 'models/m.onnx.part'])
      expect(existsSync(join(d, k))).toBe(true)
  })
  it('prunes old and excess crash reports', () => {
    const d = mkdtempSync(join(tmpdir(), 'ud-crash-'))
    mkdirSync(join(d, 'crash'))
    const now = Date.now()
    writeFileSync(join(d, 'crash', 'crash-0-old.json'), '{}')
    utimesSync(join(d, 'crash', 'crash-0-old.json'), 1, 1)
    for (let i = 1; i <= CRASH_KEEP + 2; i++)
      writeFileSync(join(d, 'crash', `crash-${String(i).padStart(4, '0')}.json`), '{}')
    cleanupUserData(d, now)
    expect(existsSync(join(d, 'crash', 'crash-0-old.json'))).toBe(false)
    expect(existsSync(join(d, 'crash', 'crash-0001.json'))).toBe(false)
    expect(
      existsSync(join(d, 'crash', `crash-${String(CRASH_KEEP + 2).padStart(4, '0')}.json`))
    ).toBe(true)
  })
  it('tolerates a missing dir; restricts POSIX permissions to the owner', () => {
    expect(cleanupUserData('/nonexistent/zzz').removed).toEqual([])
    if (process.platform === 'win32') return
    const d = join(mkdtempSync(join(tmpdir(), 'ud-perm-')), 'u')
    restrictPermissions(d)
    expect(statSync(d).mode & 0o077).toBe(0)
    expect(statSync(join(d, 'logs')).mode & 0o077).toBe(0)
  })
})
