// Interrupted-download experiment for 8.4.1 (Linux). Runs the REAL electron-updater (AppImage provider,
// generic feed) + our UpdaterController inside Electron against a local server that drops the
// connection mid-file, corrupts bytes, or truncates. Asserts a bad file is never accepted.
//   node scripts/update-resilience.mjs     (needs xvfb-run on headless boxes)
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '../package.json'))
const work = mkdtempSync(join(tmpdir(), 'upd-res-'))
const esbuild = require('esbuild')
esbuild.buildSync({
  entryPoints: [join(here, '../src/main/updater.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(work, 'updater.cjs')
})

const body = randomBytes(6 * 1024 * 1024)
const sha512 = createHash('sha512').update(body).digest('base64')
const NAME = 'Mizaj-Studio-Setup-0.2.0.AppImage'
const yml = `version: 0.2.0\nfiles:\n  - url: ${NAME}\n    sha512: ${sha512}\n    size: ${body.length}\npath: ${NAME}\nsha512: ${sha512}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`
// behaviour of successive downloads of the AppImage: drop, corrupt, truncate, then good
const plan = ['drop', 'corrupt', 'truncate', 'good']
let n = 0
const hits = []
const srv = createServer((req, res) => {
  if (process.env.UPD_DEBUG) console.log('req', req.url)
  if (req.url.split('?')[0].endsWith('.yml')) return res.end(yml)
  if (!req.url.includes('AppImage')) {
    res.statusCode = 404
    return res.end()
  }
  if (req.headers.range) {
    res.statusCode = 416
    return res.end()
  } // no ranges: force full downloads
  const mode = plan[Math.min(n++, plan.length - 1)]
  hits.push(mode)
  if (mode === 'good') {
    res.setHeader('Content-Length', body.length)
    return res.end(body)
  }
  if (mode === 'drop') {
    res.setHeader('Content-Length', body.length)
    res.write(body.subarray(0, body.length * 0.4))
    return setTimeout(() => req.socket.destroy(), 100)
  }
  if (mode === 'corrupt') {
    const b = Buffer.from(body)
    b[1000] ^= 0xff
    res.setHeader('Content-Length', b.length)
    return res.end(b)
  }
  const part = body.subarray(0, body.length - 4096) // complete HTTP response, but short file
  res.setHeader('Content-Length', part.length)
  res.end(part)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port

const mainJs = `
const { app, net } = require('electron')
const { autoUpdater } = require('electron-updater')
const { UpdaterController } = require(${JSON.stringify(join(work, 'updater.cjs'))})
const fs = require('fs'), path = require('path')
const events = []
app.whenReady().then(async () => {
  autoUpdater.forceDevUpdateConfig = true
  autoUpdater.setFeedURL({ provider: 'generic', url: 'http://127.0.0.1:${port}' })
  const done = new Promise((res) => {
    const ctl = new UpdaterController({
      updater: autoUpdater, isPackaged: true, retryDelaysMs: [300, 300, 300, 300, 300],
      logger: { info() {}, warn() {}, error(...a) { console.log('  [err]', String(a[1] && a[1].message || a[1]).split('\\n')[0].slice(0, 120)) } },
      send: (s) => { console.log('  [state]', s.state, s.message ? s.message.slice(0,100) : ''); events.push(s.state + (s.attempt ? '#' + s.attempt : '')); if (s.state === 'available') ctl.download(); if (s.state === 'downloaded' || s.state === 'error') res(s) },
      flushRenderer: async () => {}, stopSidecar: async () => {}, isOnline: () => net.isOnline()
    })
    ctl.check(true)
  })
  const final = await done
  const cache = path.join(process.env.HOME, '.cache', app.getName(), 'pending')
  const files = fs.existsSync(cache) ? fs.readdirSync(cache) : []
  const f = files.find((x) => x.endsWith('.AppImage'))
  const sha = f ? require('crypto').createHash('sha512').update(fs.readFileSync(path.join(cache, f))).digest('base64') : null
  fs.writeFileSync(${JSON.stringify(join(work, 'result.json'))}, JSON.stringify({ final: final.state, events, files, sha }))
  app.exit(0)
})
`
writeFileSync(join(work, 'main.cjs'), mainJs)
writeFileSync(
  join(work, 'dev-app-update.yml'),
  `provider: generic\nurl: http://127.0.0.1:${port}\n`
)
writeFileSync(
  join(work, 'package.json'),
  JSON.stringify({ name: 'upd-res', version: '0.1.0', main: 'main.cjs' })
)
require('node:fs').symlinkSync(join(here, '../node_modules'), join(work, 'node_modules'))
const electron = require('electron')
const r = await new Promise((resolve) => {
  const c = spawn('xvfb-run', ['-a', electron, '--no-sandbox', '--no-proxy-server', work], {
    env: {
      ...process.env,
      HOME: join(work, 'home'),
      XDG_CACHE_HOME: join(work, 'home', '.cache'),
      APPIMAGE: join(work, 'fake.AppImage')
    }
  })
  let stdout = '',
    stderr = ''
  c.stdout.on('data', (d) => (stdout += d))
  c.stderr.on('data', (d) => (stderr += d))
  const t = setTimeout(() => c.kill('SIGKILL'), 90000)
  c.on('close', (status, signal) => {
    clearTimeout(t)
    resolve({ stdout, stderr, status, signal })
  })
})
srv.close()
process.stdout.write(
  (r.stdout || '')
    .split('\n')
    .filter((l) => l.includes('[err]') || l.includes('[state]'))
    .join('\n') + '\n'
)
if (!require('node:fs').existsSync(join(work, 'result.json'))) {
  console.log(
    (r.stdout || '').slice(-3000),
    (r.stderr || '')
      .split('\n')
      .filter((l) => !/bus.cc|viz_main/.test(l))
      .join('\n'),
    r.status,
    r.signal
  )
  process.exit(1)
}
const res = JSON.parse(readFileSync(join(work, 'result.json'), 'utf8'))
console.log('server saw:', hits.join(' -> '))
console.log('updater states:', res.events.join(' > '))
console.log('cache files:', res.files)
const ok =
  res.final === 'downloaded' &&
  res.sha === sha512 &&
  hits.join() === plan.join() &&
  !res.files.some((x) => x.startsWith('temp-'))
console.log(
  ok ? 'PASS: only the intact file was accepted; bad attempts left nothing behind' : 'FAIL'
)
if (!process.env.UPD_KEEP) rmSync(work, { recursive: true, force: true })
else console.log('kept', work)
process.exit(ok ? 0 : 1)
