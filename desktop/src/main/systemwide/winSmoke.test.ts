import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WinAutomation } from './automation'
import { cloneDefault } from './config'
import { contentContainer, decodeContainer, readHtmlFormat, readUnicodeText } from './container'
import { buildCfHtml, parseCfHtml } from './htmlText'
import type { PipelineDeps } from './pipeline'
import { SystemwideService } from './service'

/**
 * Windows smoke test of the REAL automation (PowerShell helper, SendInput, clipboard, Word COM).
 * Runs only on Windows with MIZAJ_WIN_SMOKE=1 (job "systemwide-smoke" in
 * .github/workflows/windows-e2e.yml); everywhere else it is skipped. The backend is replaced by a
 * deterministic fake so no Python is needed: this test is about the OS side (focus, copy, paste,
 * clipboard restore, Word COM). Word steps are skipped when Word is not installed.
 */
const ON = process.platform === 'win32' && process.env.MIZAJ_WIN_SMOKE === '1'
const suite = ON ? describe : describe.skip
if (ON) vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 })

const scriptsDir = resolve(__dirname, '../../../resources/systemwide')
const fixture = resolve(__dirname, '../../../tests/win-smoke/word-fixture.ps1')
const PS = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

const TEXT = 'هذا كتاب جميل جدا'
const OUT = 'هذا كِتَابٌ جميل جدا'
const backend: PipelineDeps = {
  proofread: async () => ({ items: [] }),
  apply: async (text) => ({ text, applied: 0, skipped: 0 }),
  tashkeel: async (text) => ({ text: text.replace(/كتاب/g, 'كِتَابٌ') })
}

let root = ''
let seq = 0
const notes: string[] = []
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function runPs(script: string, req: Record<string, unknown>): Promise<Json> {
  const id = ++seq
  const rq = join(root, `r${id}.json`)
  const rs = join(root, `s${id}.json`)
  writeFileSync(rq, JSON.stringify({ ...req, dir: root }))
  return new Promise((ok, fail) => {
    execFile(
      PS,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Request',
        rq,
        '-Response',
        rs
      ],
      { windowsHide: true, timeout: 60_000 },
      (err) => (err ? fail(err) : ok(JSON.parse(readFileSync(rs, 'utf8'))))
    )
  })
}
const win = (req: Record<string, unknown>): Promise<Json> =>
  runPs(join(scriptsDir, 'winauto.ps1'), req)
const fx = (req: Record<string, unknown>): Promise<Json> => runPs(fixture, req)

/** Small throw-away PowerShell snippets (no user text in them). */
function snippet(name: string, body: string): Promise<Json> {
  const script = join(root, `${name}-${++seq}.ps1`)
  writeFileSync(script, `param($Request,$Response)\n${body}\n`)
  return runPs(script, {})
}

function setClipboard(plain: string, html?: string): Promise<Json> {
  const p = join(root, `c${++seq}.bin`)
  writeFileSync(p, contentContainer(plain, html ? buildCfHtml(html) : undefined))
  return win({ cmd: 'clip-set', contentPath: p })
}

async function dumpClipboard(): Promise<{ text: string | null; html: string | null }> {
  const p = join(root, `d${++seq}.bin`)
  expect((await win({ cmd: 'clip-dump', outPath: p })).ok).toBe(true)
  const entries = decodeContainer(readFileSync(p)) ?? []
  const raw = readHtmlFormat(entries)
  return { text: readUnicodeText(entries), html: raw ? parseCfHtml(raw).html : null }
}

const service = (auto: WinAutomation): SystemwideService =>
  new SystemwideService({
    automation: auto,
    backend,
    getConfig: () => ({ ...cloneDefault(), enabled: true, replaceMode: 'direct' }),
    hooks: {
      onState: () => undefined,
      showPopup: () => undefined,
      hidePopup: () => undefined,
      notify: (m) => void notes.push(m),
      log: () => undefined
    }
  })

async function notepadWindow(): Promise<number> {
  const r = await snippet(
    'notepad',
    '$p = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; $h = 0; if ($p) { $h = [int64]$p.MainWindowHandle }; [IO.File]::WriteAllText($Response, (@{ hwnd = $h } | ConvertTo-Json -Compress))'
  )
  return Number(r.hwnd) || 0
}

suite('Windows automation smoke (real PowerShell helper)', () => {
  let auto: WinAutomation
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mizaj-win-smoke-'))
    mkdirSync(join(root, 'tmp'), { recursive: true })
    auto = new WinAutomation({
      tmpRoot: join(root, 'tmp'),
      scriptsDir,
      exec: (file, args, opts) =>
        new Promise((ok, fail) => execFile(file, args, opts, (e) => (e ? fail(e) : ok())))
    })
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reports the foreground window and its elevation', async () => {
    const r = await win({ cmd: 'info' })
    expect(r.ok).toBe(true)
    expect(typeof r.fg.hwnd).toBe('number')
    expect(typeof r.fg.elevated).toBe('boolean')
  })

  it('clipboard: every format is saved and restored (HTML + text survive a clear)', async () => {
    const html =
      '<html><body><!--StartFragment--><p><b style="color:red">نص</b> أصلي</p><!--EndFragment--></body></html>'
    expect((await setClipboard('نص أصلي', html)).ok).toBe(true)
    const before = await dumpClipboard()
    expect(before.text).toBe('نص أصلي')
    expect(before.html).toBe(html)
    const r = await win({ cmd: 'clipboard-roundtrip' })
    expect(r.ok).toBe(true)
    expect(r.emptied).toBe(true) // it really was cleared in between
    expect(await dumpClipboard()).toEqual(before)
  })

  describe('Notepad round trip', () => {
    let notepad: ChildProcess | null = null
    afterAll(() => {
      notepad?.kill()
      spawn('taskkill', ['/IM', 'notepad.exe', '/F'], { windowsHide: true, stdio: 'ignore' })
    })

    it('empty selection -> «لم يُنسخ أي نص محدد»; type, select, run the pipeline, read back; clipboard restored', async () => {
      notepad = spawn('notepad.exe', [], { stdio: 'ignore' })
      let hwnd = 0
      for (let i = 0; i < 40 && !hwnd; i++) {
        await sleep(500)
        hwnd = await notepadWindow()
      }
      expect(hwnd, 'Notepad window not found').toBeGreaterThan(0)
      expect((await win({ cmd: 'focus', hwnd })).ok).toBe(true)

      // a freshly opened Notepad is empty: Ctrl+C copies nothing
      await expect(auto.capture()).rejects.toMatchObject({ code: 'no_selection' })

      // the rich clipboard the user "had" before using the feature
      const richHtml = '<html><body><!--StartFragment--><i>قبل</i><!--EndFragment--></body></html>'
      await setClipboard('قبل', richHtml)
      const sentinel = await dumpClipboard()

      // type the text (paste), then select all
      const typed = join(root, 'typed.bin')
      writeFileSync(typed, contentContainer(TEXT))
      expect((await win({ cmd: 'paste', contentPath: typed, hwnd, restoreDelayMs: 600 })).ok).toBe(
        true
      )
      await sleep(300)
      expect((await win({ cmd: 'ctrl-key', key: 'A' })).ok).toBe(true)

      // the real pipeline: capture (Ctrl+C), process, paste back (Ctrl+V), restore the clipboard
      await service(auto).trigger('tashkeel')
      expect(notes.at(-1) ?? '').toContain('تم الاستبدال')
      await sleep(1000) // the clipboard restore delay

      // read back what Notepad now contains
      expect((await win({ cmd: 'focus', hwnd })).ok).toBe(true)
      expect((await win({ cmd: 'ctrl-key', key: 'A' })).ok).toBe(true)
      const back = await auto.capture()
      expect(back.kind).toBe('plain')
      expect(back.text.replace(/\r?\n$/, '')).toBe(OUT)
      await sleep(1000)

      // the user's clipboard is exactly what it was before the feature was used
      expect(await dumpClipboard()).toEqual(sentinel)
    })
  })

  describe('Word (skipped when Word is not installed)', () => {
    let hasWord = false
    beforeAll(async () => {
      hasWord = !!(
        await snippet(
          'hasword',
          "[IO.File]::WriteAllText($Response, (@{ ok = [bool](Test-Path 'Registry::HKEY_CLASSES_ROOT\\Word.Application') } | ConvertTo-Json -Compress))"
        )
      ).ok
      if (!hasWord)
        console.log(
          '::notice title=systemwide-smoke::Word is not installed on this runner; Word steps skipped'
        )
    })
    afterAll(async () => {
      if (hasWord) await fx({ cmd: 'close' }).catch(() => undefined)
    })

    it('formatting survives: minimal edits on Range objects, one Ctrl+Z undoes everything', async (ctx) => {
      if (!hasWord) return ctx.skip()
      const first = 'كتاب'
      const text = `${first} جميل جدا اليوم`
      const c = await fx({ cmd: 'create', text, firstLength: first.length })
      expect(c.ok).toBe(true)
      await win({ cmd: 'focus', hwnd: c.hwnd })
      await sleep(500)

      const before = await fx({ cmd: 'inspect' })
      expect((await auto.capture()).kind).toBe('word') // the COM path, not the clipboard
      await service(auto).trigger('tashkeel')
      await sleep(500)

      const after = await fx({ cmd: 'inspect' })
      expect(after.text).toContain('كِتَابٌ')
      expect((after.text as string).replace(/[\u064B-\u0652]/g, '')).toBe(text)
      // the first and last characters keep their formatting
      expect(after.first).toEqual({ ...before.first })
      expect(after.last).toEqual({ ...before.last })
      expect(after.first.bold).toBe(-1)
      expect(after.first.color).toBe(255)
      expect(after.first.size).toBe(20)
      expect(after.last.font).toBe('Arial')

      expect((await fx({ cmd: 'undo' })).text).toBe(text) // a single undo restores the original
    })
  })
})
