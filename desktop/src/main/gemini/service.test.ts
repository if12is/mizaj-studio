import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_BASE } from './api'
import { GeminiConfigStore, sanitizeConfig } from './config'
import { GeminiKeyStore } from './keyStore'
import { GeminiService } from './service'
import { SessionStore } from './sessions'

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
  return new GeminiService({
    keys: new GeminiKeyStore(join(dir, 'k.bin'), storage),
    config: new GeminiConfigStore(join(dir, 'c.json')),
    base: DEFAULT_BASE,
    sessions: new SessionStore(join(dir, 'sessions')),
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
    expect(sanitizeConfig(null)).toMatchObject({ enabled: false, consentAt: null })
    expect(sanitizeConfig({ model: '../x y', provider: 'evil' })).toEqual({
      enabled: false,
      model: '',
      consentAt: null
    })
  })
  it('migrates a former Gemini CLI config to API mode and rewrites the file', () => {
    const f = join(dir, 'old.json')
    writeFileSync(
      f,
      JSON.stringify({ enabled: true, provider: 'cli', useCli: true, model: 'gemini-2.5-flash' })
    )
    const c = new GeminiConfigStore(f).get()
    expect(c).toMatchObject({ enabled: true, model: 'gemini-2.5-flash' })
    expect(c).not.toHaveProperty('provider')
    const disk = JSON.parse(readFileSync(f, 'utf8'))
    expect(disk).not.toHaveProperty('useCli')
    expect(disk).not.toHaveProperty('provider')
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
    s.setConfig({ enabled: true, model: 'gemini-2.5-flash' })
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
      sessions: new SessionStore(join(dir, 'sessions')),
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    })
    expect(await off.models()).toMatchObject({ ok: true, source: 'fallback' })
  })
})
