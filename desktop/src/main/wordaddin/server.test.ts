import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PipelineDeps } from '../systemwide/pipeline'
import { generateCert } from './cert'
import { AddinServer, AddinServerError } from './server'

const TOKEN = 'T'.repeat(43)
const deps: PipelineDeps = {
  proofread: async () => ({ items: [] }),
  apply: async (text) => ({ text, applied: 0, skipped: 0 }),
  tashkeel: async (t) => ({ text: t.replace('كتاب', 'كَتابُ') })
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

interface Res {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}
function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
  tls?: { ca: string }
): Promise<Res> {
  return new Promise((ok, fail) => {
    const opts = {
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: { host: `localhost:${port}`, ...headers },
      ...(tls ? { ca: tls.ca, servername: 'localhost' } : {})
    }
    const r = (tls ? httpsRequest : httpRequest)(opts, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: b }))
    })
    r.on('error', fail)
    r.end(body)
  })
}

let dir: string
let port: number
let server: AddinServer
let token: string | null
let logs: string[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mz-wa-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'taskpane.html'), '<html>taskpane</html>')
  writeFileSync(join(dir, 'assets', 'a.png'), 'png')
  writeFileSync(join(dir, 'secret.txt.bak'), 'no')
  token = TOKEN
  logs = []
  port = await freePort()
  server = new AddinServer({
    root: dir,
    port,
    scheme: 'http',
    getToken: () => token,
    deps,
    engineReady: () => true,
    log: (e) => logs.push(e)
  })
  await server.start()
})
afterEach(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const apiHeaders = (): Record<string, string> => ({
  origin: `http://localhost:${port}`,
  'content-type': 'application/json',
  'x-mizaj-pair': TOKEN
})

describe('static files and pages', () => {
  it('serves the page only with the pairing token', async () => {
    expect((await call(port, 'GET', '/taskpane.html')).status).toBe(403)
    expect((await call(port, 'GET', '/taskpane.html?k=wrong')).status).toBe(403)
    const ok = await call(port, 'GET', `/taskpane.html?k=${TOKEN}`)
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('taskpane')
    expect(ok.headers['content-security-policy']).toContain("object-src 'none'")
    expect(ok.headers['referrer-policy']).toBe('no-referrer')
  })
  it('serves assets with a Host check, refuses odd hosts and traversal', async () => {
    expect((await call(port, 'GET', '/assets/a.png')).status).toBe(200)
    expect((await call(port, 'GET', '/assets/a.png', { host: 'evil.example' })).status).toBe(403)
    expect((await call(port, 'GET', '/assets/../../etc/passwd')).status).toBe(404)
    expect((await call(port, 'GET', '/%2e%2e/%2e%2e/etc/passwd')).status).toBe(404)
    expect((await call(port, 'GET', '/secret.txt.bak')).status).toBe(404)
    expect((await call(port, 'GET', '/vendor/office.js')).status).toBe(404)
  })
  it('refuses the page when the add-in is not installed (no token)', async () => {
    token = null
    expect((await call(port, 'GET', `/taskpane.html?k=${TOKEN}`)).status).toBe(403)
  })
})

describe('API', () => {
  it('health needs no secret but must be on our host', async () => {
    const r = await call(port, 'GET', '/wa/health')
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, paired: true })
    expect((await call(port, 'GET', '/wa/health', { host: 'x:1' })).status).toBe(403)
  })
  it('ping and process work with Origin + pairing token', async () => {
    const p = await call(port, 'POST', '/wa/ping', apiHeaders(), '{}')
    expect(JSON.parse(p.body)).toEqual({ ok: true, engine: true })
    const r = await call(
      port,
      'POST',
      '/wa/process',
      apiHeaders(),
      JSON.stringify({ op: 'tashkeel', paragraphs: ['كتاب', 'قلم'] })
    )
    const j = JSON.parse(r.body)
    expect(r.status).toBe(200)
    expect(j.changed).toBe(true)
    expect(j.edits).toHaveLength(2)
    expect(j.edits[1]).toEqual([])
  })
  it('refuses wrong origin / token / cross-site and never sets CORS headers', async () => {
    const body = JSON.stringify({ op: 'tashkeel', paragraphs: ['كتاب'] })
    expect(
      (
        await call(
          port,
          'POST',
          '/wa/process',
          { ...apiHeaders(), origin: 'https://evil.example' },
          body
        )
      ).status
    ).toBe(403)
    expect(
      (await call(port, 'POST', '/wa/process', { ...apiHeaders(), 'x-mizaj-pair': 'x' }, body))
        .status
    ).toBe(403)
    expect(
      (
        await call(
          port,
          'POST',
          '/wa/process',
          { ...apiHeaders(), 'sec-fetch-site': 'cross-site' },
          body
        )
      ).status
    ).toBe(403)
    const ok = await call(port, 'POST', '/wa/process', apiHeaders(), body)
    expect(ok.headers['access-control-allow-origin']).toBeUndefined()
    // preflight from another site gets nothing useful
    expect(
      (await call(port, 'OPTIONS', '/wa/process', { origin: 'https://evil.example' })).status
    ).not.toBe(200)
  })
  it('validates the body and maps pipeline errors to Arabic messages', async () => {
    expect((await call(port, 'POST', '/wa/process', apiHeaders(), '{not json')).status).toBe(400)
    expect(
      (
        await call(
          port,
          'POST',
          '/wa/process',
          apiHeaders(),
          JSON.stringify({ op: 'x', paragraphs: ['a'] })
        )
      ).status
    ).toBe(400)
    const r = await call(
      port,
      'POST',
      '/wa/process',
      apiHeaders(),
      JSON.stringify({ op: 'all', paragraphs: ['hello'] })
    )
    expect(r.status).toBe(422)
    expect(JSON.parse(r.body).message_ar).toContain('عربي')
  })
  it('rejects oversized bodies', async () => {
    const big = JSON.stringify({ op: 'tashkeel', paragraphs: ['ا'.repeat(2_100_000)] })
    const r = await call(port, 'POST', '/wa/process', apiHeaders(), big)
    expect(r.status).toBe(400)
  })
  it('never logs the text or the token', async () => {
    await call(
      port,
      'POST',
      '/wa/process',
      apiHeaders(),
      JSON.stringify({ op: 'tashkeel', paragraphs: ['كتاب'] })
    )
    await call(port, 'GET', `/taskpane.html?k=${TOKEN}`)
    const all = logs.join('\n')
    expect(all).not.toContain('كتاب')
    expect(all).not.toContain(TOKEN)
  })
})

describe('lifecycle', () => {
  it('reports a busy port with a typed error', async () => {
    const other = new AddinServer({
      root: dir,
      port,
      scheme: 'http',
      getToken: () => null,
      deps,
      engineReady: () => false,
      log: () => undefined
    })
    await expect(other.start()).rejects.toMatchObject({ code: 'port_in_use' })
    await expect(other.start()).rejects.toBeInstanceOf(AddinServerError)
  })
  it('stop frees the port', async () => {
    await server.stop()
    expect(server.listening).toBe(false)
    await expect(call(port, 'GET', '/wa/health')).rejects.toBeTruthy()
  })
})

describe('real TLS with the generated certificate', () => {
  it('a client that trusts exactly that certificate can talk to the server over HTTPS', async () => {
    const c = generateCert()
    const p = await freePort()
    const s = new AddinServer({
      root: dir,
      port: p,
      scheme: 'https',
      tls: { key: c.keyPem, cert: c.certPem },
      getToken: () => TOKEN,
      deps,
      engineReady: () => true,
      log: () => undefined
    })
    await s.start()
    try {
      const r = await call(p, 'GET', '/wa/health', {}, undefined, { ca: c.certPem })
      expect(r.status).toBe(200)
      // a client that does not trust it is refused (the cert is what Windows must be told to trust)
      await expect(call(p, 'GET', '/wa/health')).rejects.toBeTruthy()
    } finally {
      await s.stop()
    }
  })
})
