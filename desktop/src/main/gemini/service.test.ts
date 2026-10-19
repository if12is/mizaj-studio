import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BASE } from './api'
import { defaultDeps } from './cli'
import { GeminiConfigStore, sanitizeConfig } from './config'
import { GeminiKeyStore } from './keyStore'
import { GeminiService } from './service'

const KEY = 'AIzaSyDUMMYKEYFORTESTS1234567890abcd'
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s).reverse(),
  decryptString: (b: Buffer) => Buffer.from(b).reverse().toString()
}
let dir: string
let calls: { url: string; headers: Record<string, string>; body: string }[]
let reply: unknown
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-svc-'))
  calls = []
  reply = { candidates: [{ content: { parts: [{ text: 'جواب' }] } }] }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function svc(): GeminiService {
  const cliPath = join(dir, 'gemini')
  writeFileSync(
    cliPath,
    `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log('رد من CLI'))`
  )
  chmodSync(cliPath, 0o755)
  return new GeminiService({
    keys: new GeminiKeyStore(join(dir, 'k.bin'), storage),
    config: new GeminiConfigStore(join(dir, 'c.json')),
    base: DEFAULT_BASE,
    cli: { ...defaultDeps(), env: { PATH: dir } },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: String(init.body ?? '')
      })
      return new Response(JSON.stringify(reply), { status: 200 })
    }) as unknown as typeof fetch
  })
}
const docReq = { kind: 'document', question: 'ما الخطأ؟', text: 'نص المستند' } as const

describe('config sanitising', () => {
  it('is off by default and drops junk', () => {
    expect(sanitizeConfig(null)).toMatchObject({ enabled: false, provider: 'api', consentAt: null })
    expect(sanitizeConfig({ model: '../x y', provider: 'evil' })).toMatchObject({
      model: '',
      provider: 'api'
    })
  })
})

describe('GeminiService', () => {
  it('refuses to ask while disabled, then until consent is given', async () => {
    const s = svc()
    expect(await s.ask(docReq)).toMatchObject({ ok: false, code: 'disabled' })
    s.setConfig({ enabled: true })
    s.saveKey(KEY)
    expect(await s.ask(docReq)).toMatchObject({ ok: false, code: 'consent' })
    expect(calls).toHaveLength(0) // nothing was sent
    s.acceptConsent()
    expect(await s.ask(docReq)).toMatchObject({ ok: true })
    expect(calls).toHaveLength(1)
  })
  it('consent cannot be set through setConfig', () => {
    const s = svc()
    s.setConfig({ consentAt: '2020-01-01' })
    expect(s.setConfig({}).config.consentAt).toBeNull()
  })
  it('API provider: key only in the header, state never contains the key', async () => {
    const s = svc()
    s.saveKey(KEY)
    s.setConfig({ enabled: true, provider: 'api', model: 'gemini-2.5-flash' })
    s.acceptConsent()
    await s.ask(docReq)
    expect(calls[0].headers['x-goog-api-key']).toBe(KEY)
    expect(calls[0].url).toContain('/models/gemini-2.5-flash:generateContent')
    expect(calls[0].url + calls[0].body).not.toContain(KEY)
    const st = JSON.stringify(await s.getState())
    expect(st).not.toContain(KEY)
    expect(st).toContain('abcd')
  })
  it('API provider without a key says so', async () => {
    const s = svc()
    s.setConfig({ enabled: true })
    s.acceptConsent()
    expect(await s.ask(docReq)).toMatchObject({ ok: false, code: 'no_key' })
  })
  it.runIf(process.platform !== 'win32')(
    'CLI provider is used instead of the API and needs opt-in',
    async () => {
      const s = svc()
      s.saveKey(KEY)
      s.setConfig({ enabled: true, provider: 'cli' })
      s.acceptConsent()
      expect(await s.ask(docReq)).toMatchObject({ ok: false, code: 'disabled' }) // useCli not ticked
      s.setConfig({ useCli: true })
      const r = await s.ask(docReq)
      expect(r).toMatchObject({ ok: true, result: { text: 'رد من CLI', provider: 'cli' } })
      expect(calls).toHaveLength(0) // API not touched
    }
  )
  it('flags truncated documents and parses the suggestion block', async () => {
    const s = svc()
    s.saveKey(KEY)
    s.setConfig({ enabled: true })
    s.acceptConsent()
    reply = {
      candidates: [{ content: { parts: [{ text: 'x\n```mizaj-suggestion\nكَتَبَ\n```' }] } }]
    }
    const r = await s.ask({ kind: 'document', question: 'س', text: 'ا'.repeat(700_000) })
    // document questions never yield a suggestion
    expect(r).toMatchObject({ ok: true, result: { truncated: true, suggestion: null } })
    const w = await s.ask({ kind: 'selection', question: 'س', text: 'كتب' })
    expect(w).toMatchObject({ ok: true, result: { suggestion: 'كَتَبَ' } })
  })
  it('sends a 100k-char document whole, with no truncation', async () => {
    const s = svc()
    s.saveKey(KEY)
    s.setConfig({ enabled: true })
    s.acceptConsent()
    const r = await s.ask({ kind: 'document', question: 'س', text: 'ب'.repeat(100_000) })
    expect(r).toMatchObject({ ok: true, result: { truncated: false } })
    expect(calls.at(-1)!.body.length).toBeGreaterThan(100_000)
  })
  it('rejects oversized / empty questions', async () => {
    const s = svc()
    s.saveKey(KEY)
    s.setConfig({ enabled: true })
    s.acceptConsent()
    expect(await s.ask({ ...docReq, question: ' ' })).toMatchObject({
      ok: false,
      code: 'bad_request'
    })
  })
  it('model list falls back offline only', async () => {
    const s = svc()
    s.saveKey(KEY)
    const off = new GeminiService({
      keys: new GeminiKeyStore(join(dir, 'k.bin'), storage),
      config: new GeminiConfigStore(join(dir, 'c.json')),
      base: DEFAULT_BASE,
      cli: defaultDeps(),
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    })
    expect(await off.models()).toMatchObject({ ok: true, source: 'fallback' })
  })
})
