import { readFile, stat } from 'node:fs/promises'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { BackendError } from '../systemwide/backend'
import { PipelineError, type PipelineDeps } from '../systemwide/pipeline'
import {
  MAX_BODY_BYTES,
  RateLimiter,
  checkApi,
  checkPage,
  checkStatic,
  type GuardConfig,
  type GuardResult
} from './guard'
import { ProcessError, parseProcessRequest, processParagraphs } from './process'

/**
 * The HTTPS host of the Word add-in, inside the Mizaj main process:  https://localhost:<port>.
 *
 * Routes (nothing else exists):
 *   GET  /taskpane.html, /commands.html      the add-in pages (need the pairing token as ?k=)
 *   GET  /assets/*, /*.js, /*.css, /sw.js     static files of the add-in build (Host check only)
 *   GET  /vendor/*                            optional local copy of Office.js (see docs)
 *   GET  /wa/health                           liveness, no secret
 *   POST /wa/ping                             pairing + engine readiness (API guard)
 *   POST /wa/process                          the one processing endpoint (API guard)
 *
 * The page never receives the general backend API token: this process calls the backend itself.
 * Document text is only in request/response bodies; it is never logged (event codes only).
 */

export type AddinServerErrorCode = 'port_in_use' | 'listen_failed'
export class AddinServerError extends Error {
  constructor(public readonly code: AddinServerErrorCode) {
    super(code)
    this.name = 'AddinServerError'
  }
}

export interface AddinServerOptions {
  /** folder with the built add-in (taskpane.html, commands.html, assets, ...) */
  root: string
  port: number
  scheme: 'https' | 'http'
  tls?: { key: string; cert: string }
  getToken: () => string | null
  deps: PipelineDeps
  engineReady: () => boolean
  /** folder with an optional local Office.js copy, or null */
  vendorDir?: () => string | null
  log: (event: string) => void
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}
const PAGES = new Set(['/taskpane.html', '/commands.html'])

const HTML_CSP = "object-src 'none'; base-uri 'none'; form-action 'none'"

export class AddinServer {
  private servers: Server[] = []
  private busy = false
  private readonly limiter = new RateLimiter(120, 10_000)

  constructor(private readonly o: AddinServerOptions) {}

  get listening(): boolean {
    return this.servers.length > 0
  }

  private guardCfg(): GuardConfig {
    return { port: this.o.port, scheme: this.o.scheme, token: this.o.getToken() }
  }

  async start(): Promise<void> {
    if (this.servers.length) return
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      this.handle(req, res).catch(() => {
        this.o.log('wordaddin: handler error')
        if (!res.headersSent) this.sendJson(res, 500, { ok: false, code: 'internal' })
        else res.end()
      })
    }
    const make = (): Server =>
      this.o.scheme === 'https' && this.o.tls
        ? createHttpsServer(
            { key: this.o.tls.key, cert: this.o.tls.cert, minVersion: 'TLSv1.2' },
            handler
          )
        : createHttpServer(handler)
    const listen = (s: Server, host: string): Promise<void> =>
      new Promise((ok, fail) => {
        s.once('error', fail)
        s.listen(this.o.port, host, () => {
          s.off('error', fail)
          ok()
        })
      })
    const primary = make()
    try {
      await listen(primary, '127.0.0.1')
    } catch (e) {
      primary.close()
      throw new AddinServerError(
        (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'port_in_use' : 'listen_failed'
      )
    }
    this.servers.push(primary)
    // "localhost" may resolve to ::1 first: serve it too when the machine has IPv6 loopback (best effort)
    const v6 = make()
    try {
      await listen(v6, '::1')
      this.servers.push(v6)
    } catch {
      v6.close()
    }
  }

  async stop(): Promise<void> {
    const list = this.servers
    this.servers = []
    await Promise.all(
      list.map(
        (s) =>
          new Promise<void>((ok) => {
            s.close(() => ok())
            s.closeAllConnections?.()
          })
      )
    )
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    })
    res.end(data)
  }

  private deny(res: ServerResponse, g: Extract<GuardResult, { ok: false }>): void {
    this.o.log(`wordaddin: denied ${g.code}`)
    this.sendJson(res, g.status, { ok: false, code: g.code })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if (path === '/wa/health') {
      const g = checkStatic(req, this.guardCfg())
      if (!g.ok) return this.deny(res, g)
      return this.sendJson(res, 200, {
        ok: true,
        app: 'mizaj-word-addin',
        v: 1,
        paired: this.o.getToken() !== null
      })
    }
    if (path === '/wa/ping' || path === '/wa/process') {
      const g = checkApi(req, this.guardCfg())
      if (!g.ok) return this.deny(res, g)
      if (!this.limiter.allow()) return this.sendJson(res, 429, { ok: false, code: 'rate_limited' })
      if (path === '/wa/ping')
        return this.sendJson(res, 200, { ok: true, engine: this.o.engineReady() })
      return this.process(req, res)
    }
    return this.serveStatic(req, res, path, url.searchParams.get('k'))
  }

  private async readBody(req: IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += (c as Buffer).length
      // an oversized body is drained (not stored) up to a hard cap so the client sees a clean 400
      if (size > MAX_BODY_BYTES * 10) {
        req.destroy()
        return null
      }
      if (size <= MAX_BODY_BYTES) chunks.push(c as Buffer)
    }
    return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8')
  }

  private async process(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.busy)
      return this.sendJson(res, 429, {
        ok: false,
        code: 'busy',
        message_ar: 'المعالجة السابقة لم تنتهِ بعد.'
      })
    this.busy = true
    try {
      const raw = await this.readBody(req)
      let parsed: unknown = null
      try {
        parsed = raw === null ? null : JSON.parse(raw)
      } catch {
        parsed = null
      }
      const r = parseProcessRequest(parsed)
      if (!r)
        return this.sendJson(res, 400, {
          ok: false,
          code: 'bad_request',
          message_ar: 'طلب غير صالح.'
        })
      const out = await processParagraphs(r, this.o.deps)
      this.o.log(`wordaddin: processed ${r.op} changed=${out.changed}`)
      this.sendJson(res, 200, out)
    } catch (e) {
      if (e instanceof PipelineError || e instanceof ProcessError) {
        this.o.log(`wordaddin: error ${e.code}`)
        return this.sendJson(res, 422, { ok: false, code: e.code, message_ar: e.messageAr })
      }
      if (e instanceof BackendError) {
        this.o.log(`wordaddin: backend ${e.code}`)
        return this.sendJson(res, 503, { ok: false, code: e.code, message_ar: e.messageAr })
      }
      this.o.log('wordaddin: error unexpected')
      this.sendJson(res, 500, {
        ok: false,
        code: 'unexpected',
        message_ar: 'حدث خطأ غير متوقع. لم يُغيَّر النص.'
      })
    } finally {
      this.busy = false
    }
  }

  private async serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    k: string | null
  ): Promise<void> {
    const cfg = this.guardCfg()
    const g = PAGES.has(path) ? checkPage(req, cfg, k) : checkStatic(req, cfg)
    if (!g.ok) return this.deny(res, g)
    let base = this.o.root
    let rel = path
    if (path.startsWith('/vendor/')) {
      const v = this.o.vendorDir?.() ?? null
      if (!v) return this.sendJson(res, 404, { ok: false, code: 'not_found' })
      base = v
      rel = path.slice('/vendor'.length)
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(rel)
    } catch {
      return this.sendJson(res, 400, { ok: false, code: 'bad_request' })
    }
    const file = resolve(join(base, normalize(decoded)))
    const rootResolved = resolve(base)
    const ext = extname(file).toLowerCase()
    if (!file.startsWith(rootResolved + sep) || !MIME[ext] || decoded.includes('\0'))
      return this.sendJson(res, 404, { ok: false, code: 'not_found' })
    try {
      const st = await stat(file)
      if (!st.isFile()) throw new Error('nf')
      const data = await readFile(file)
      const headers: Record<string, string | number> = {
        'Content-Type': MIME[ext],
        'Content-Length': data.length,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': ext === '.html' || path === '/sw.js' ? 'no-store' : 'no-cache'
      }
      if (ext === '.html') headers['Content-Security-Policy'] = HTML_CSP
      if (path === '/sw.js') headers['Service-Worker-Allowed'] = '/'
      res.writeHead(200, headers)
      res.end(req.method === 'HEAD' ? undefined : data)
    } catch {
      this.sendJson(res, 404, { ok: false, code: 'not_found' })
    }
  }
}
