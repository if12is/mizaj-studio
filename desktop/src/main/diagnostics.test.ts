import { inflateRawSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildBundle,
  buildBundleEntries,
  buildCrashReport,
  filterSettings,
  sanitizeLine,
  sanitizeText,
  tailLines,
  writeCrashReport,
  type VersionInfo
} from './diagnostics'
import { crc32, createZip } from './zip'
import { isPortable, resolveUserDataDir } from './paths'

const versions: VersionInfo = {
  app: '0.1.2',
  electron: '31',
  chrome: '126',
  node: '20',
  platform: 'win32',
  arch: 'x64',
  osRelease: '10',
  totalMemMB: 8000,
  freeMemMB: 4000,
  packaged: true,
  portable: false
}

describe('sanitization', () => {
  it('removes Windows/unix/UNC paths, home dirs and e-mails', () => {
    const l = sanitizeLine(
      'open C:\\Users\\Ahmed\\Documents\\عقد.docx and /home/ahmed/x.txt \\\\srv\\share\\f.docx mail a.b@c.com',
      ['C:\\Users\\Ahmed']
    )
    expect(l).not.toMatch(/Ahmed|ahmed|c\.com|\\Users|\/home/)
    expect(l).toContain('<path>')
    expect(l).toContain('<email>')
  })
  it('removes long Arabic runs (document text) but keeps short technical words', () => {
    const doc = 'يلتزم المستأجر بدفع الأجرة الشهرية في موعدها المحدد'
    const l = sanitizeLine(`ERROR failed on "${doc}" code=5 كتاب`)
    expect(l).not.toContain('المستأجر')
    expect(l).toContain('[نص محجوب]')
    expect(l).toContain('code=5')
    expect(l).toContain('كتاب')
  })
  it('removes very long quoted strings', () => {
    expect(sanitizeLine(`body="${'x'.repeat(200)}"`)).toContain('<long text removed>')
  })
  it('sanitizeText works per line and tailLines keeps the end', () => {
    expect(sanitizeText('a\nC:\\x\\y\nb')).toBe('a\n<path>\nb')
    expect(tailLines('1\n2\n3\n4', 2)).toBe('3\n4')
  })
  it('settings whitelist drops per-document and word-list keys', () => {
    const s = filterSettings({
      theme: 'dark',
      'manual_edits:5': '{"words":["سر"]}',
      spelling_ignore: '["كلمة"]',
      engine_mode: 'fast'
    })
    expect(s).toEqual({ theme: 'dark', engine_mode: 'fast' })
  })
})

describe('crash report + bundle', () => {
  it('crash report is sanitized and written locally', () => {
    const err = new Error(
      'failed at C:\\Users\\Ali\\a.docx: ' + 'نص طويل جدا من المستند هنا للاختبار'
    )
    err.stack = 'Error: x\n    at f (C:\\Users\\Ali\\app\\main.js:1:1)'
    const r = buildCrashReport('uncaughtException', err, versions, ['C:\\Users\\Ali'])
    expect(JSON.stringify(r)).not.toMatch(/Ali|المستند هنا/)
    const dir = mkdtempSync(join(tmpdir(), 'crash-'))
    const f = writeCrashReport(join(dir, 'crash'), r)
    expect(f).toMatch(/crash-.*uncaughtException\.json$/)
  })

  it('bundle zip is valid, contains whitelisted data only and no document text', () => {
    const ud = mkdtempSync(join(tmpdir(), 'ud-'))
    mkdirSync(join(ud, 'logs'))
    writeFileSync(
      join(ud, 'logs', 'mizaj-main.log'),
      'info start C:\\Users\\Bob\\x\ninfo "يلتزم المستأجر بدفع الأجرة الشهرية في موعدها"\n'
    )
    writeFileSync(join(ud, 'logs', 'mizaj-backend.log'), 'INFO ok\n')
    const zip = buildBundle({
      userData: ud,
      versions,
      health: { status: 'ok' },
      settings: { theme: 'dark', 'manual_edits:1': 'secret', spelling_ignore: '["سري"]' },
      homes: ['C:\\Users\\Bob']
    })
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    const names = buildBundleEntries({
      userData: ud,
      versions,
      health: {},
      settings: {},
      homes: []
    }).map((e) => e.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'README.txt',
        'versions.json',
        'health.json',
        'settings.json',
        'logs/mizaj-main.log',
        'logs/mizaj-backend.log'
      ])
    )
    const all = readZip(zip)
    const joined = Object.values(all).join('\n')
    expect(joined).not.toMatch(/Bob|المستأجر|secret|سري/)
    expect(JSON.parse(all['settings.json'])).toEqual({ theme: 'dark' })
  })
})

function readZip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let p = 0
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8)
    const crc = buf.readUInt32LE(p + 14)
    const csize = buf.readUInt32LE(p + 18)
    const nlen = buf.readUInt16LE(p + 26)
    const name = buf.subarray(p + 30, p + 30 + nlen).toString('utf8')
    const data = buf.subarray(p + 30 + nlen, p + 30 + nlen + csize)
    const raw = method === 8 ? inflateRawSync(data) : data
    expect(crc32(raw)).toBe(crc)
    out[name] = raw.toString('utf8')
    p += 30 + nlen + csize
  }
  return out
}

describe('zip writer', () => {
  it('round-trips entries with unicode names and verifies crc, EOCD entry count', () => {
    const z = createZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/ملف.txt', data: Buffer.from('مرحبا') }
    ])
    const r = readZip(z)
    expect(r['a.txt']).toBe('hello')
    expect(r['dir/ملف.txt']).toBe('مرحبا')
    expect(z.readUInt16LE(z.length - 22 + 10)).toBe(2)
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })
})

describe('user data location', () => {
  it('portable puts data next to the exe; test override wins; default otherwise', () => {
    expect(resolveUserDataDir({})).toBeNull()
    expect(resolveUserDataDir({ PORTABLE_EXECUTABLE_DIR: '/usb/app' })).toBe(
      join('/usb/app', 'MizajData')
    )
    expect(
      resolveUserDataDir({ PORTABLE_EXECUTABLE_DIR: '/usb/app', MIZAJ_USER_DATA_DIR: '/t' })
    ).toBe('/t')
    expect(isPortable({ PORTABLE_EXECUTABLE_DIR: 'x' })).toBe(true)
    expect(isPortable({})).toBe(false)
  })
})
