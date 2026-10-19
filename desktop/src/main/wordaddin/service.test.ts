import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PipelineDeps } from '../systemwide/pipeline'
import type { Exec } from './install'
import { readManifestFacts } from './manifest'
import { WordAddinService, sanitizeConfig, type SecretBox } from './service'

const pipeline: PipelineDeps = {
  proofread: async () => ({ items: [] }),
  apply: async (t) => ({ text: t, applied: 0, skipped: 0 }),
  tashkeel: async (t) => ({ text: t })
}
const secrets: SecretBox = {
  encrypt: (s) => Buffer.from(s, 'utf8'),
  decrypt: (b) => b.toString('utf8')
}

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => ok(p))
    })
  })
}

/** A fake Windows: a registry value table and a CurrentUser\Root store. */
class FakeWindows {
  registry = new Map<string, string>()
  roots = new Set<string>()
  userSaysNo = false
  word = true
  calls: string[] = []
  constructor(private readFile: (p: string) => string) {}
  exec: Exec = async (file, args) => {
    this.calls.push(`${file} ${args.slice(0, 3).join(' ')}`)
    if (file === 'reg.exe') {
      if (args[0] === 'add') this.registry.set(args[3], args[7])
      if (args[0] === 'delete') {
        const had = this.registry.delete(args[3])
        return { code: had ? 0 : 1, stdout: '' }
      }
      if (args[0] === 'query') {
        if (args[1].includes('\\Word')) return { code: this.word ? 0 : 1, stdout: '' }
        if (args[1].includes('EdgeUpdate')) return { code: 0, stdout: '' }
        const v = this.registry.get(args[3])
        return v
          ? { code: 0, stdout: `\r\nHKEY\r\n    ${args[3]}    REG_SZ    ${v}\r\n` }
          : { code: 1, stdout: '' }
      }
      return { code: 0, stdout: '' }
    }
    if (args[1] === '-addstore') {
      if (this.userSaysNo) return { code: 1, stdout: '' }
      const pem = this.readFile(args[3])
      const { createHash } = await import('node:crypto')
      const der = Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64')
      this.roots.add(createHash('sha1').update(der).digest('hex').toUpperCase())
      return { code: 0, stdout: '' }
    }
    if (args[1] === '-store')
      return { code: this.roots.has(args[3].toUpperCase()) ? 0 : 1, stdout: '' }
    if (args[1] === '-delstore')
      return { code: this.roots.delete(args[3].toUpperCase()) ? 0 : 1, stdout: '' }
    return { code: 1, stdout: '' }
  }
}

let tmp: string
let root: string
let dir: string
let port: number
let win: FakeWindows
let svc: WordAddinService
let wefCleared = 0

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mz-wsvc-'))
  root = join(tmp, 'site')
  dir = join(tmp, 'userData', 'wordaddin')
  mkdirSync(root, { recursive: true })
  copyFileSync(
    resolve(__dirname, '../../../word-addin/manifest.template.xml'),
    join(root, 'manifest.template.xml')
  )
  writeFileSync(join(root, 'taskpane.html'), '<html></html>')
  port = await freePort()
  win = new FakeWindows((p) => readFileSync(p, 'utf8'))
  wefCleared = 0
  svc = mk()
})
afterEach(async () => {
  await svc.dispose()
  rmSync(tmp, { recursive: true, force: true })
})

function mk(over: { supported?: boolean; secrets?: SecretBox } = {}): WordAddinService {
  return new WordAddinService({
    dir,
    rootDir: root,
    exec: win.exec,
    secrets: over.secrets ?? secrets,
    pipeline,
    engineReady: () => true,
    supported: over.supported ?? true,
    log: () => undefined,
    port,
    clearWefCache: () => void wefCleared++
  })
}

describe('off by default', () => {
  it('writes and listens to nothing until the user enables it', async () => {
    await svc.start()
    const s = await svc.getState()
    expect(s).toMatchObject({ enabled: false, installed: false, running: false })
    expect(existsSync(dir)).toBe(false)
    expect(win.calls).toEqual([])
  })
  it('the config reader tolerates garbage and never turns the feature on', () => {
    expect(sanitizeConfig('x').enabled).toBe(false)
    expect(sanitizeConfig({ enabled: 'yes', pairToken: 'short', installed: true }).installed).toBe(
      false
    )
  })
  it('is unavailable off Windows', async () => {
    const s = mk({ supported: false })
    const st = await s.setEnabled(true)
    expect(st.enabled).toBe(false)
    expect(st.error).toContain('ويندوز')
  })
})

describe('enable, install, test, uninstall', () => {
  it('install requires the feature to be enabled', async () => {
    const r = await svc.install()
    expect(r.ok).toBe(false)
    expect(win.registry.size).toBe(0)
  })

  it('full lifecycle with a real HTTPS listener and a fake Windows', async () => {
    const en = await svc.setEnabled(true)
    expect(en).toMatchObject({ enabled: true, running: true, installed: false })
    expect(en.cert.exists).toBe(true)
    // the private key is only stored through the secret box
    expect(existsSync(join(dir, 'key.bin'))).toBe(true)

    const ins = await svc.install()
    expect(ins.ok).toBe(true)
    expect(ins.steps.map((s) => s.id)).toEqual(['cert', 'trust', 'manifest', 'registry'])
    expect(wefCleared).toBe(1)
    const st = ins.state
    expect(st.installed).toBe(true)
    expect(st.cert.trusted).toBe(true)

    // the registry points at the generated manifest, whose facts match the config
    const [[id, path]] = [...win.registry.entries()]
    expect(path).toBe(st.manifestPath)
    const facts = readManifestFacts(readFileSync(path, 'utf8'))
    expect(facts.id).toBe(id)
    expect(facts.port).toBe(port)

    const t = await svc.test()
    expect(t.roundTrip).toEqual({ https: true, paired: true, engine: true })
    expect(t.ok).toBe(true)

    const un = await svc.uninstall()
    expect(un.ok).toBe(true)
    expect(win.registry.size).toBe(0)
    expect(win.roots.size).toBe(0)
    expect(existsSync(path)).toBe(false)
    expect(un.state).toMatchObject({ installed: false, enabled: true, running: true })
    // pairing is gone: the old token no longer opens the page
    const after = await svc.test()
    expect(after.ok).toBe(false)
  })

  it('reinstalling replaces the registration, the token and the id', async () => {
    await svc.setEnabled(true)
    await svc.install()
    const first = [...win.registry.keys()][0]
    const tok1 = readManifestFacts(readFileSync(svc.manifestPath, 'utf8')).token
    await svc.install()
    expect(win.registry.size).toBe(1)
    expect([...win.registry.keys()][0]).not.toBe(first)
    expect(readManifestFacts(readFileSync(svc.manifestPath, 'utf8')).token).not.toBe(tok1)
  })

  it('declining the Windows certificate prompt stops the install before anything is registered', async () => {
    await svc.setEnabled(true)
    win.userSaysNo = true
    const r = await svc.install()
    expect(r.ok).toBe(false)
    expect(r.steps.at(-1)).toMatchObject({ id: 'trust', ok: false })
    expect(win.registry.size).toBe(0)
    expect(r.state.installed).toBe(false)
  })

  it('disabling stops the listener but keeps the installation', async () => {
    await svc.setEnabled(true)
    await svc.install()
    const st = await svc.setEnabled(false)
    expect(st).toMatchObject({ enabled: false, running: false, installed: true })
  })

  it('without OS encryption the key is never written and the feature stays off', async () => {
    const s = mk({ secrets: { encrypt: () => null, decrypt: () => null } })
    const st = await s.setEnabled(true)
    expect(st.enabled).toBe(false)
    expect(st.error).toContain('تشفير')
    expect(existsSync(join(dir, 'key.bin'))).toBe(false)
  })

  it('a busy port is reported, not thrown', async () => {
    const blocker = createServer()
    await new Promise<void>((ok) => blocker.listen(port, '127.0.0.1', ok))
    try {
      const st = await svc.setEnabled(true)
      expect(st.enabled).toBe(false)
      expect(st.error).toContain('المنفذ')
    } finally {
      blocker.close()
    }
  })

  it('the enabled flag survives a restart and start() brings the server back', async () => {
    await svc.setEnabled(true)
    await svc.dispose()
    const again = mk()
    expect((await again.getState()).running).toBe(false)
    await again.start()
    expect((await again.getState()).running).toBe(true)
    await again.dispose()
  })
})
