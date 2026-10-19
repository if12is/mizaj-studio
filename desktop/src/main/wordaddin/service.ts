import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { join } from 'node:path'
import type { PipelineDeps } from '../systemwide/pipeline'
import { generateCert, inspectCert, keyMatchesCert, pemToDer, type CertInfo } from './cert'
import {
  buildChecks,
  checksPassed,
  detectEnvironment,
  isCertTrusted,
  queryRegistration,
  registerAddin,
  trustCert,
  unregisterAddin,
  untrustCert,
  type Check,
  type Exec
} from './install'
import { ADDIN_PORT, buildManifest, readManifestFacts } from './manifest'
import { PAIR_HEADER, PAIR_TOKEN_BYTES } from './guard'
import { AddinServer, AddinServerError, type AddinServerOptions } from './server'

/**
 * Orchestrates the Word add-in: certificate, HTTPS server, manifest, registry sideload and the
 * self-test. Pure of Electron (everything platform-specific is injected), so the flow is tested with
 * fakes. Everything is OFF by default: nothing listens and nothing is written until the user enables it.
 *
 * Files under <userData>/wordaddin/ : config.json, cert.pem, key.bin (DPAPI-protected through
 * safeStorage; never stored in clear text), catalog/mizaj-word-addin.xml. No document text anywhere.
 */

export interface WordAddinConfig {
  enabled: boolean
  installed: boolean
  addinId: string | null
  /** per-install pairing token (also inside the manifest URLs) */
  pairToken: string | null
  certThumbprint: string | null
}

export const DEFAULT_CONFIG: WordAddinConfig = {
  enabled: false,
  installed: false,
  addinId: null,
  pairToken: null,
  certThumbprint: null
}

export function sanitizeConfig(raw: unknown): WordAddinConfig {
  const out = { ...DEFAULT_CONFIG }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.installed === 'boolean') out.installed = r.installed
  if (typeof r.addinId === 'string' && /^[0-9a-f-]{36}$/i.test(r.addinId)) out.addinId = r.addinId
  if (typeof r.pairToken === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(r.pairToken))
    out.pairToken = r.pairToken
  if (typeof r.certThumbprint === 'string' && /^[0-9A-F]{40}$/.test(r.certThumbprint))
    out.certThumbprint = r.certThumbprint
  if (!out.addinId || !out.pairToken) out.installed = false
  return out
}

export interface SecretBox {
  /** null when OS encryption is unavailable (then the key is NOT stored) */
  encrypt(s: string): Buffer | null
  decrypt(b: Buffer): string | null
}

export interface ServiceDeps {
  /** <userData>/wordaddin */
  dir: string
  /** built add-in files (taskpane.html, ...) and manifest.template.xml */
  rootDir: string
  exec: Exec
  secrets: SecretBox
  pipeline: PipelineDeps
  engineReady: () => boolean
  /** Windows (or the e2e mock) only */
  supported: boolean
  log: (event: string) => void
  port?: number
  /** best effort: remove Office's cached add-in manifests (%LOCALAPPDATA%\Microsoft\Office\16.0\Wef) */
  clearWefCache?: () => void
  vendorDir?: () => string | null
  makeServer?: (o: AddinServerOptions) => AddinServer
}

export interface CertState {
  exists: boolean
  thumbprint: string | null
  notAfter: string | null
  trusted: boolean | null
  needsRenewal: boolean
  expired: boolean
}

export interface WordAddinState {
  supported: boolean
  enabled: boolean
  installed: boolean
  running: boolean
  port: number
  cert: CertState
  manifestPath: string | null
  catalogDir: string
  officeJsLocal: boolean
  /** Arabic message of the last failure, or null */
  error: string | null
}

export interface StepResult {
  id: string
  ok: boolean
  text: string
}
export interface InstallResult {
  ok: boolean
  steps: StepResult[]
  state: WordAddinState
}
export interface TestResult {
  ok: boolean
  checks: Check[]
  /** HTTPS + pairing round trip through the real listener, with the certificate pinned */
  roundTrip: { https: boolean; paired: boolean; engine: boolean }
}

const ERR_AR: Record<string, string> = {
  port_in_use: 'المنفذ مشغول ببرنامج آخر. أغلقه ثم أعد المحاولة.',
  listen_failed: 'تعذّر تشغيل خادم الإضافة على هذا الجهاز.',
  no_safe_storage: 'تعذّر تشفير مفتاح الشهادة عبر ويندوز، فلم تُنشأ الشهادة.',
  not_enabled: 'فعّل الميزة أولاً.',
  unsupported: 'هذه الميزة تعمل على ويندوز فقط.'
}

function httpsJson(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  pin: Buffer
): Promise<{ status: number; json: Record<string, unknown> | null; pinned: boolean }> {
  return new Promise((ok, fail) => {
    const r = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        servername: 'localhost',
        // The server certificate is verified by PINNING (its exact DER must equal ours), not by a
        // chain build: different TLS stacks (OpenSSL vs Electron's BoringSSL) disagree about a
        // self-signed leaf as trust anchor, while Windows' own store is checked separately.
        rejectUnauthorized: false,
        timeout: 8000,
        headers: { host: `localhost:${port}`, ...headers }
      },
      (res) => {
        // the socket is released after 'end': read the presented certificate now
        const raw = (res.socket as TLSSocket).getPeerCertificate()?.raw
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          let json: Record<string, unknown> | null = null
          try {
            json = JSON.parse(b) as Record<string, unknown>
          } catch {
            /* not json */
          }
          ok({ status: res.statusCode ?? 0, json, pinned: !!raw && raw.equals(pin) })
        })
      }
    )
    r.on('error', fail)
    r.on('timeout', () => r.destroy(new Error('timeout')))
    if (body) r.write(body)
    r.end()
  })
}

export class WordAddinService {
  private config: WordAddinConfig
  private server: AddinServer | null = null
  private lastError: string | null = null
  private readonly port: number

  constructor(private readonly d: ServiceDeps) {
    this.port = d.port ?? ADDIN_PORT
    this.config = this.loadConfig()
    if (!d.supported) this.config = { ...this.config, enabled: false }
  }

  // ---- files ----------------------------------------------------------------------------
  private f = (name: string): string => join(this.d.dir, name)
  get catalogDir(): string {
    return this.f('catalog')
  }
  get manifestPath(): string {
    return join(this.catalogDir, 'mizaj-word-addin.xml')
  }

  private loadConfig(): WordAddinConfig {
    try {
      const p = this.f('config.json')
      return existsSync(p)
        ? sanitizeConfig(JSON.parse(readFileSync(p, 'utf8')))
        : { ...DEFAULT_CONFIG }
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  private saveConfig(): void {
    mkdirSync(this.d.dir, { recursive: true })
    const tmp = this.f('config.json.tmp')
    writeFileSync(tmp, JSON.stringify(this.config, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.f('config.json'))
  }

  // ---- certificate ----------------------------------------------------------------------
  private readCert(): { certPem: string; keyPem: string; info: CertInfo } | null {
    try {
      if (!existsSync(this.f('cert.pem')) || !existsSync(this.f('key.bin'))) return null
      const certPem = readFileSync(this.f('cert.pem'), 'utf8')
      const keyPem = this.d.secrets.decrypt(readFileSync(this.f('key.bin')))
      const info = inspectCert(certPem)
      if (!keyPem || !info || !keyMatchesCert(certPem, keyPem)) return null
      return { certPem, keyPem, info }
    } catch {
      return null
    }
  }

  /** Creates the certificate when missing / unreadable / expired. Returns whether it was (re)generated. */
  private ensureCert(renewSoon = false): { regenerated: boolean } | { error: string } {
    const cur = this.readCert()
    if (
      cur &&
      !cur.info.expired &&
      !(renewSoon && cur.info.needsRenewal) &&
      cur.info.validForLocalhost
    )
      return { regenerated: false }
    const g = generateCert()
    const enc = this.d.secrets.encrypt(g.keyPem)
    if (!enc) return { error: 'no_safe_storage' }
    mkdirSync(this.d.dir, { recursive: true })
    writeFileSync(this.f('key.bin'), enc, { mode: 0o600 })
    writeFileSync(this.f('cert.pem'), g.certPem, { encoding: 'utf8', mode: 0o600 })
    this.config = { ...this.config, certThumbprint: g.thumbprint }
    this.saveConfig()
    return { regenerated: true }
  }

  // ---- server ---------------------------------------------------------------------------
  private async startServer(): Promise<string | null> {
    if (this.server?.listening) return null
    const c = this.readCert()
    if (!c) return 'no_safe_storage'
    const opts: AddinServerOptions = {
      root: this.d.rootDir,
      port: this.port,
      scheme: 'https',
      tls: { key: c.keyPem, cert: c.certPem },
      getToken: () => (this.config.installed ? this.config.pairToken : null),
      deps: this.d.pipeline,
      engineReady: this.d.engineReady,
      vendorDir: this.d.vendorDir,
      log: this.d.log
    }
    const s = this.d.makeServer ? this.d.makeServer(opts) : new AddinServer(opts)
    try {
      await s.start()
    } catch (e) {
      return e instanceof AddinServerError ? e.code : 'listen_failed'
    }
    this.server = s
    return null
  }

  private async stopServer(): Promise<void> {
    const s = this.server
    this.server = null
    await s?.stop()
  }

  /** App start: bring the server up only when the user enabled the feature. */
  async start(): Promise<void> {
    if (!this.config.enabled || !this.d.supported) return
    const e = this.ensureCert(true)
    this.lastError = 'error' in e ? ERR_AR[e.error] : null
    if (!this.lastError) {
      const r = await this.startServer()
      this.lastError = r ? ERR_AR[r] ?? ERR_AR.listen_failed : null
    }
    this.d.log(`wordaddin: start ${this.lastError ? 'failed' : 'ok'}`)
  }

  async dispose(): Promise<void> {
    await this.stopServer()
  }

  // ---- state ----------------------------------------------------------------------------
  async getState(): Promise<WordAddinState> {
    const c = this.readCert()
    let trusted: boolean | null = null
    if (this.d.supported && c) {
      try {
        trusted = await isCertTrusted(this.d.exec, c.info.thumbprint)
      } catch {
        trusted = null
      }
    }
    return {
      supported: this.d.supported,
      enabled: this.config.enabled,
      installed: this.config.installed,
      running: this.server?.listening ?? false,
      port: this.port,
      cert: {
        exists: !!c,
        thumbprint: c?.info.thumbprint ?? null,
        notAfter: c?.info.notAfter.toISOString() ?? null,
        trusted,
        needsRenewal: c?.info.needsRenewal ?? false,
        expired: c?.info.expired ?? false
      },
      manifestPath: this.config.installed ? this.manifestPath : null,
      catalogDir: this.catalogDir,
      officeJsLocal: !!this.d.vendorDir?.(),
      error: this.lastError
    }
  }

  async setEnabled(enabled: boolean): Promise<WordAddinState> {
    this.lastError = null
    if (!this.d.supported) {
      this.lastError = ERR_AR.unsupported
      return this.getState()
    }
    if (enabled) {
      const e = this.ensureCert(true)
      if ('error' in e) this.lastError = ERR_AR[e.error]
      else {
        const r = await this.startServer()
        if (r) this.lastError = ERR_AR[r] ?? ERR_AR.listen_failed
        else {
          this.config = { ...this.config, enabled: true }
          this.saveConfig()
        }
      }
    } else {
      await this.stopServer()
      this.config = { ...this.config, enabled: false }
      this.saveConfig()
    }
    return this.getState()
  }

  // ---- install / uninstall --------------------------------------------------------------
  /** Called only after the user agreed in the UI (the Windows certificate prompt follows). */
  async install(): Promise<InstallResult> {
    const steps: StepResult[] = []
    const done = async (ok: boolean, id: string, text: string): Promise<InstallResult | null> => {
      steps.push({ id, ok, text })
      if (ok) return null
      this.lastError = text
      return { ok: false, steps, state: await this.getState() }
    }
    this.lastError = null
    if (!this.d.supported)
      return (await done(false, 'platform', ERR_AR.unsupported)) as InstallResult
    if (!this.config.enabled || !this.server?.listening)
      return (await done(false, 'enabled', ERR_AR.not_enabled)) as InstallResult

    // 1. certificate (a renewed one replaces the old trust entry)
    const oldThumb = this.config.certThumbprint
    const e = this.ensureCert(true)
    if ('error' in e) return (await done(false, 'cert', ERR_AR[e.error])) as InstallResult
    if (e.regenerated) {
      await this.stopServer()
      const r = await this.startServer()
      if (r)
        return (await done(false, 'server', ERR_AR[r] ?? ERR_AR.listen_failed)) as InstallResult
      if (oldThumb && oldThumb !== this.config.certThumbprint)
        await untrustCert(this.d.exec, oldThumb).catch(() => false)
    }
    const cert = this.readCert()
    if (!cert) return (await done(false, 'cert', ERR_AR.no_safe_storage)) as InstallResult
    let r = await done(true, 'cert', 'أُنشئت شهادة https://localhost الخاصة بجهازك.')
    if (r) return r

    // 2. trust (CurrentUser\Root): Windows shows its own confirmation dialog
    const already = await isCertTrusted(this.d.exec, cert.info.thumbprint)
    if (!already) {
      const ok = await trustCert(this.d.exec, this.f('cert.pem'))
      r = await done(
        ok,
        'trust',
        ok
          ? 'وافق ويندوز على الثقة بالشهادة.'
          : 'لم تُقبل الثقة بالشهادة (ربما ضغطتَ «لا» في نافذة ويندوز). بدونها لن يفتح Word الإضافة.'
      )
      if (r) return r
    } else steps.push({ id: 'trust', ok: true, text: 'ويندوز يثق بالشهادة مسبقاً.' })

    // 3. manifest with a NEW id and pairing token (an old registration is removed first)
    const oldId = this.config.addinId
    if (oldId) await unregisterAddin(this.d.exec, oldId).catch(() => false)
    const id = randomUUID()
    const token = randomBytes(PAIR_TOKEN_BYTES).toString('base64url')
    let xml: string
    try {
      const tpl = readFileSync(join(this.d.rootDir, 'manifest.template.xml'), 'utf8')
      xml = buildManifest(tpl, { id, port: this.port, token })
    } catch {
      return (await done(false, 'manifest', 'تعذّر إنشاء ملف manifest.xml.')) as InstallResult
    }
    mkdirSync(this.catalogDir, { recursive: true })
    writeFileSync(this.manifestPath, xml, 'utf8')
    this.config = { ...this.config, installed: true, addinId: id, pairToken: token }
    this.saveConfig()
    r = await done(true, 'manifest', 'كُتب ملف manifest.xml وأُنشئ رمز الاقتران.')
    if (r) return r

    // 4. registry sideload (no share, no admin)
    const reg = await registerAddin(this.d.exec, id, this.manifestPath)
    r = await done(
      reg,
      'registry',
      reg
        ? 'سُجّلت الإضافة في Word (مفتاح المطوّر للمستخدم الحالي).'
        : 'تعذّر تسجيل الإضافة في سجل ويندوز.'
    )
    if (r) return r
    try {
      this.d.clearWefCache?.()
    } catch {
      /* Word may hold the files; harmless */
    }
    this.d.log('wordaddin: installed')
    return { ok: true, steps, state: await this.getState() }
  }

  async uninstall(): Promise<InstallResult> {
    const steps: StepResult[] = []
    this.lastError = null
    if (!this.d.supported) {
      this.lastError = ERR_AR.unsupported
      return { ok: false, steps, state: await this.getState() }
    }
    const id = this.config.addinId
    if (id) {
      const ok = await unregisterAddin(this.d.exec, id).catch(() => false)
      steps.push({
        id: 'registry',
        ok,
        text: ok ? 'أُزيل تسجيل الإضافة من Word.' : 'تعذّرت إزالة تسجيل الإضافة.'
      })
    }
    const thumb = this.config.certThumbprint
    if (thumb) {
      const ok = await untrustCert(this.d.exec, thumb).catch(() => false)
      steps.push({
        id: 'trust',
        ok,
        text: ok ? 'أُزيلت الثقة بالشهادة من ويندوز.' : 'تعذّرت إزالة الشهادة من ويندوز.'
      })
    }
    // token gone first: the server refuses every page and call from now on
    this.config = {
      ...this.config,
      installed: false,
      addinId: null,
      pairToken: null,
      certThumbprint: null
    }
    this.saveConfig()
    for (const n of ['cert.pem', 'key.bin']) rmSync(this.f(n), { force: true })
    rmSync(this.catalogDir, { recursive: true, force: true })
    try {
      this.d.clearWefCache?.()
    } catch {
      /* ignore */
    }
    steps.push({
      id: 'files',
      ok: true,
      text: 'حُذفت الشهادة ومفتاحها وملف manifest ورمز الاقتران.'
    })
    // a still-enabled feature keeps listening, with a brand-new certificate
    if (this.config.enabled) {
      await this.stopServer()
      const e = this.ensureCert()
      const r = 'error' in e ? e.error : await this.startServer()
      if (r) this.lastError = ERR_AR[r] ?? ERR_AR.listen_failed
    }
    this.d.log('wordaddin: uninstalled')
    return { ok: steps.every((s) => s.ok), steps, state: await this.getState() }
  }

  // ---- test («تحقق» / «اختبار») ----------------------------------------------------------
  async test(): Promise<TestResult> {
    const cert = this.readCert()
    const rt = { https: false, paired: false, engine: false }
    if (cert && this.server?.listening) {
      try {
        // 1. no secret is sent until the certificate presented is exactly the one we generated
        const pin = pemToDer(cert.certPem)
        const h = await httpsJson(this.port, 'GET', '/wa/health', {}, undefined, pin)
        rt.https = h.pinned && h.status === 200 && h.json?.app === 'mizaj-word-addin'
        if (rt.https && this.config.pairToken) {
          const p = await httpsJson(
            this.port,
            'POST',
            '/wa/ping',
            {
              origin: `https://localhost:${this.port}`,
              'content-type': 'application/json',
              [PAIR_HEADER]: this.config.pairToken
            },
            '{}',
            pin
          )
          rt.paired = p.status === 200 && p.json?.ok === true
          rt.engine = rt.paired && p.json?.engine === true
        }
      } catch {
        /* reported through the checklist */
      }
    }
    let registered: string | null = null
    let trusted: boolean | null = null
    let env: { word: boolean; webview2: boolean } | null = null
    if (this.d.supported) {
      try {
        registered = this.config.addinId
          ? await queryRegistration(this.d.exec, this.config.addinId)
          : null
        trusted = cert ? await isCertTrusted(this.d.exec, cert.info.thumbprint) : false
        env = await detectEnvironment(this.d.exec)
      } catch {
        /* leave nulls */
      }
    }
    let manifestExists = false
    let manifestMatches = false
    try {
      if (existsSync(this.manifestPath)) {
        manifestExists = true
        const facts = readManifestFacts(readFileSync(this.manifestPath, 'utf8'))
        manifestMatches =
          facts.id === this.config.addinId &&
          facts.port === this.port &&
          facts.token === this.config.pairToken
      }
    } catch {
      /* unreadable = mismatch */
    }
    const checks = buildChecks({
      serverListening: rt.https,
      certExists: !!cert,
      certExpired: cert?.info.expired ?? false,
      certNeedsRenewal: cert?.info.needsRenewal ?? false,
      certTrusted: trusted,
      registeredPath: registered,
      expectedManifestPath: this.manifestPath,
      manifestExists,
      manifestMatches,
      paired: this.config.installed && rt.paired,
      word: env?.word ?? null,
      webview2: env?.webview2 ?? null
    })
    if (rt.paired && !rt.engine)
      checks.push({
        id: 'server',
        level: 'warn',
        text: 'محرك مِزَاج ما زال يستعد؛ ستعمل الأزرار حين يكتمل (انتظر لحظات).'
      })
    return { ok: checksPassed(checks), checks, roundTrip: rt }
  }
}
