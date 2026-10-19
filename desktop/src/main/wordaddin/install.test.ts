import { describe, expect, it } from 'vitest'
import {
  REG_KEY,
  buildChecks,
  checksPassed,
  detectEnvironment,
  isCertTrusted,
  queryRegistration,
  registerAddin,
  trustCert,
  unregisterAddin,
  untrustCert,
  type CheckInput,
  type Exec
} from './install'

const ID = '5f1c2b7e-3a44-4c1f-9b0e-0d6e8a1c9a11'
const THUMB = 'A'.repeat(40)

function recorder(reply: (file: string, args: string[]) => { code: number; stdout?: string }) {
  const calls: [string, string[]][] = []
  const exec: Exec = async (file, args) => {
    calls.push([file, args])
    const r = reply(file, args)
    return { code: r.code, stdout: r.stdout ?? '' }
  }
  return { exec, calls }
}

describe('registry sideload (HKCU WEF Developer)', () => {
  it('writes the manifest path under the add-in id, REG_SZ, forced, current user only', async () => {
    const { exec, calls } = recorder(() => ({ code: 0 }))
    expect(await registerAddin(exec, ID, 'C:\\Users\\أحمد\\AppData\\mizaj\\manifest.xml')).toBe(
      true
    )
    expect(calls[0]).toEqual([
      'reg.exe',
      [
        'add',
        REG_KEY,
        '/v',
        ID,
        '/t',
        'REG_SZ',
        '/d',
        'C:\\Users\\أحمد\\AppData\\mizaj\\manifest.xml',
        '/f'
      ]
    ])
    expect(REG_KEY.startsWith('HKCU\\')).toBe(true)
  })
  it('removes only that value; an absent value is success', async () => {
    const { exec, calls } = recorder(() => ({ code: 1 }))
    expect(await unregisterAddin(exec, ID)).toBe(true)
    expect(calls[0][1]).toEqual(['delete', REG_KEY, '/v', ID, '/f'])
    expect(await unregisterAddin(recorder(() => ({ code: 5 })).exec, ID)).toBe(false)
  })
  it('parses reg query output regardless of locale', async () => {
    const out = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer\r\n    ${ID}    REG_SZ    C:\\Users\\Ali Q\\a b\\manifest.xml\r\n\r\n`
    const { exec } = recorder(() => ({ code: 0, stdout: out }))
    expect(await queryRegistration(exec, ID)).toBe('C:\\Users\\Ali Q\\a b\\manifest.xml')
    expect(await queryRegistration(recorder(() => ({ code: 1 })).exec, ID)).toBeNull()
  })
  it('refuses anything that is not a GUID (no argument injection)', async () => {
    const { exec } = recorder(() => ({ code: 0 }))
    await expect(registerAddin(exec, 'x /f', 'p')).rejects.toThrow()
    expect(await queryRegistration(exec, 'x')).toBeNull()
  })
})

describe('certificate in the CurrentUser Root store', () => {
  it('adds to the user store only (no admin) and checks / removes by thumbprint', async () => {
    const { exec, calls } = recorder(() => ({ code: 0 }))
    expect(await trustCert(exec, 'C:\\x\\cert.pem')).toBe(true)
    expect(await isCertTrusted(exec, THUMB)).toBe(true)
    expect(await untrustCert(exec, THUMB)).toBe(true)
    expect(calls.map((c) => c[1].slice(0, 3))).toEqual([
      ['-user', '-addstore', 'Root'],
      ['-user', '-store', 'Root'],
      ['-user', '-delstore', 'Root']
    ])
  })
  it('the user declining the Windows prompt is reported as not trusted', async () => {
    expect(await trustCert(recorder(() => ({ code: 1 })).exec, 'c.pem')).toBe(false)
  })
  it('rejects a malformed thumbprint', async () => {
    const { exec } = recorder(() => ({ code: 0 }))
    await expect(untrustCert(exec, 'x"; calc')).rejects.toThrow()
    expect(await isCertTrusted(exec, 'zz')).toBe(false)
  })
  it('untrust is fine when the cert was already gone', async () => {
    const { exec } = recorder((_f, a) => ({
      code: a[1] === '-delstore' ? 1 : a[1] === '-store' ? 1 : 0
    }))
    expect(await untrustCert(exec, THUMB)).toBe(true)
  })
})

it('detects Word and WebView2', async () => {
  const { exec } = recorder((_f, a) => ({
    code: a[1].includes('Office') ? 0 : a[1].includes('HKLM') ? 0 : 1
  }))
  expect(await detectEnvironment(exec)).toEqual({ word: true, webview2: true })
  expect(await detectEnvironment(recorder(() => ({ code: 1 })).exec)).toEqual({
    word: false,
    webview2: false
  })
})

describe('verification checklist', () => {
  const good: CheckInput = {
    serverListening: true,
    certExists: true,
    certExpired: false,
    certNeedsRenewal: false,
    certTrusted: true,
    registeredPath: 'C:\\m\\manifest.xml',
    expectedManifestPath: 'c:\\M\\Manifest.xml',
    manifestExists: true,
    manifestMatches: true,
    paired: true,
    word: true,
    webview2: true
  }
  it('all green', () => {
    const c = buildChecks(good)
    expect(c.every((x) => x.level === 'ok')).toBe(true)
    expect(checksPassed(c)).toBe(true)
  })
  it('each failure is reported in Arabic and blocks success', () => {
    const cases: [Partial<CheckInput>, string][] = [
      [{ serverListening: false }, 'server'],
      [{ certExists: false }, 'cert-file'],
      [{ certExpired: true }, 'cert-file'],
      [{ certTrusted: false }, 'cert-trust'],
      [{ registeredPath: null }, 'registry'],
      [{ registeredPath: 'C:\\other.xml' }, 'registry'],
      [{ manifestExists: false }, 'manifest'],
      [{ manifestMatches: false }, 'manifest'],
      [{ paired: false }, 'pairing']
    ]
    for (const [patch, id] of cases) {
      const c = buildChecks({ ...good, ...patch })
      const bad = c.find((x) => x.id === id)
      expect(bad?.level, id).toBe('fail')
      expect(bad?.text).toMatch(/[\u0600-\u06FF]/)
      expect(checksPassed(c)).toBe(false)
    }
  })
  it('renewal / missing Word / missing WebView2 only warn', () => {
    const c = buildChecks({
      ...good,
      certNeedsRenewal: true,
      word: false,
      webview2: false,
      certTrusted: null
    })
    expect(c.filter((x) => x.level === 'warn').length).toBe(4)
    expect(checksPassed(c)).toBe(true)
  })
})
