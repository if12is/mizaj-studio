import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AutomationError, WinAutomation, type ExecFn } from './automation'
import {
  CF_UNICODETEXT,
  HTML_FORMAT,
  contentContainer,
  decodeContainer,
  encodeContainer,
  readHtmlFormat,
  readUnicodeText,
  unicodeTextEntry
} from './container'
import { buildCfHtml, parseCfHtml } from './htmlText'

type Req = Record<string, unknown> & {
  cmd: string
  dir: string
  outPath?: string
  contentPath?: string
}
type Resp = Record<string, unknown>
const FG = { hwnd: 4242, pid: 9, exe: 'notepad.exe', elevated: false }

let root: string
let calls: { script: string; req: Req; args: string[] }[]
let handler: (script: string, req: Req) => Resp | 'timeout' | 'noresp'

const exec: ExecFn = async (_file, args) => {
  const script = basename(args[args.indexOf('-File') + 1], '.ps1')
  const req = JSON.parse(readFileSync(args[args.indexOf('-Request') + 1], 'utf8')) as Req
  calls.push({ script, req, args })
  const r = handler(script, req)
  if (r === 'timeout')
    throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' })
  if (r === 'noresp') return
  writeFileSync(args[args.indexOf('-Response') + 1], JSON.stringify(r))
}

const make = (platform: NodeJS.Platform = 'win32'): WinAutomation =>
  new WinAutomation({
    tmpRoot: join(root, 'systemwide-tmp'),
    scriptsDir: 'S',
    exec,
    powershell: 'ps.exe',
    platform
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mz-auto-'))
  calls = []
  handler = () => ({ ok: false, error: 'bad_command' })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const leftovers = (): string[] => {
  const d = join(root, 'systemwide-tmp')
  return existsSync(d) ? readdirSync(d) : []
}

function copied(req: Req, entries: Parameters<typeof encodeContainer>[0]): Resp {
  writeFileSync(req.outPath as string, encodeContainer(entries))
  return { ok: true, word: false, copied: true, fg: FG }
}

describe('capture: rich clipboard path', () => {
  it('reads CF_HTML and returns the HTML payload and its text', async () => {
    const html =
      '<html><body><!--StartFragment--><p><b>كتاب</b> جميل</p><!--EndFragment--></body></html>'
    handler = (_s, req) =>
      copied(req, [
        {
          id: 0,
          name: HTML_FORMAT,
          data: Buffer.concat([buildCfHtml(html, ['SourceURL:https://x/']), Buffer.from([0])])
        },
        unicodeTextEntry('كتاب جميل')
      ])
    const sel = await make().capture()
    expect(sel).toMatchObject({
      kind: 'html',
      text: 'كتاب جميل',
      extra: ['SourceURL:https://x/'],
      fg: FG
    })
    expect(sel.kind === 'html' && sel.cfHtml).toBe(html)
    expect(calls.map((c) => c.req.cmd)).toEqual(['capture'])
  })

  it('falls back to plain text when the program offers no HTML', async () => {
    handler = (_s, req) => copied(req, [unicodeTextEntry('نص عادي')])
    expect(await make().capture()).toMatchObject({ kind: 'plain', text: 'نص عادي' })
  })

  it('HTML without visible text falls back to the plain text', async () => {
    handler = (_s, req) =>
      copied(req, [
        {
          id: 0,
          name: HTML_FORMAT,
          data: buildCfHtml('<html><body><img src="a.png"></body></html>')
        },
        unicodeTextEntry('نص')
      ])
    expect(await make().capture()).toMatchObject({ kind: 'plain' })
  })

  it('reports «لم يُنسخ أي نص محدد» when nothing was copied (timeout of the clipboard change)', async () => {
    handler = () => ({ ok: true, word: false, copied: false, fg: FG })
    await expect(make().capture()).rejects.toMatchObject({ code: 'no_selection' })
    handler = (_s, req) => copied(req, [unicodeTextEntry('   ')])
    await expect(make().capture()).rejects.toMatchObject({ code: 'no_selection' })
  })

  it('maps helper errors: elevated windows, terminals, held modifiers, busy clipboard', async () => {
    for (const code of [
      'elevated',
      'terminal',
      'modifiers_held',
      'clipboard_busy',
      'no_window'
    ] as const) {
      handler = () => ({ ok: false, error: code, fg: FG })
      await expect(make().capture()).rejects.toMatchObject({ code })
    }
    handler = () => ({ ok: false, error: 'helper_failed', detail: 'x' })
    await expect(make().capture()).rejects.toMatchObject({ code: 'helper_failed' })
    const e = new AutomationError('elevated')
    expect(e.messageAr).toContain('Administrator')
  })

  it('a hung helper is reported as a timeout, a missing response as helper_failed', async () => {
    handler = () => 'timeout'
    await expect(make().capture()).rejects.toMatchObject({ code: 'timeout' })
    handler = () => 'noresp'
    await expect(make().capture()).rejects.toMatchObject({ code: 'helper_failed' })
  })

  it('is Windows only', async () => {
    await expect(make('linux').capture()).rejects.toMatchObject({ code: 'unsupported' })
    expect(calls).toEqual([])
  })
})

describe('capture: Word path', () => {
  const wordCapture: Resp = { ok: true, word: true, fg: { ...FG, exe: 'WINWORD.EXE' } }

  it('uses COM when offsets and text agree', async () => {
    handler = (s, req) =>
      s === 'winauto'
        ? wordCapture
        : req.cmd === 'read'
          ? {
              ok: true,
              empty: false,
              text: 'كتاب',
              start: 7,
              end: 11,
              consistent: true,
              reasons: []
            }
          : {}
    expect(await make().capture()).toMatchObject({ kind: 'word', text: 'كتاب', start: 7, end: 11 })
    expect(calls.map((c) => `${c.script}:${c.req.cmd}`)).toEqual(['winauto:capture', 'word:read'])
  })

  it('falls back to the clipboard when Range offsets differ from Text indices', async () => {
    const reasons: Resp[] = [
      {
        ok: true,
        empty: false,
        text: 'كتاب',
        start: 7,
        end: 12,
        consistent: false,
        reasons: ['fields']
      }, // field codes
      { ok: true, empty: false, text: 'ك\u0007', start: 7, end: 8, consistent: true, reasons: [] }, // cell mark in the text
      { ok: true, empty: false, text: 'كتاب', start: 7, end: 20, consistent: true, reasons: [] }, // length mismatch
      { ok: false, error: 'word_unavailable' } // COM not available
    ]
    for (const w of reasons) {
      calls = []
      handler = (s, req) => {
        if (s === 'winauto')
          return req.forceCopy ? copied(req, [unicodeTextEntry('كتاب')]) : wordCapture
        return w
      }
      const sel = await make().capture()
      expect(sel.kind).toBe('plain')
      expect(calls.map((c) => `${c.script}:${c.req.cmd}:${c.req.forceCopy ?? ''}`)).toEqual([
        'winauto:capture:',
        'word:read:',
        'winauto:capture:true'
      ])
    }
  })

  it('no selection in Word and protected documents are reported, not worked around', async () => {
    handler = (s, req) =>
      s === 'winauto' ? wordCapture : req.cmd === 'read' ? { ok: true, empty: true } : {}
    await expect(make().capture()).rejects.toMatchObject({ code: 'no_selection' })
    handler = (s) => (s === 'winauto' ? wordCapture : { ok: false, error: 'word_protected' })
    await expect(make().capture()).rejects.toMatchObject({ code: 'word_protected' })
  })

  it('applyWordEdits sends edits and the expected text, and maps changed/mismatch', async () => {
    const sel = { kind: 'word' as const, text: 'كتاب', start: 7, end: 11, fg: FG }
    handler = () => ({ ok: true })
    await make().applyWordEdits(sel, [{ start: 1, end: 1, insert: 'ِ' }], 5)
    const req = calls[0].req
    expect(calls[0].script).toBe('word')
    expect(req).toMatchObject({
      cmd: 'apply',
      start: 7,
      end: 11,
      expected: 'كتاب',
      newLength: 5,
      undoName: 'مِزَاج'
    })
    expect(req.edits).toEqual([{ s: 1, e: 1, ins: 'ِ' }])
    handler = () => ({ ok: false, error: 'changed' })
    await expect(make().applyWordEdits(sel, [], 4)).rejects.toMatchObject({ code: 'word_changed' })
    handler = () => ({ ok: false, error: 'mismatch' })
    await expect(make().applyWordEdits(sel, [], 4)).rejects.toMatchObject({ code: 'word_mismatch' })
    handler = () => ({ ok: false, error: 'word_failed' })
    await expect(make().applyWordEdits(sel, [], 4)).rejects.toMatchObject({ code: 'word_failed' })
  })
})

describe('paste and focus', () => {
  it('writes the content container with HTML Format + CF_UNICODETEXT, targets the window', async () => {
    let seen: ReturnType<typeof decodeContainer> = null
    handler = (_s, req) => {
      seen = decodeContainer(readFileSync(req.contentPath as string))
      return { ok: true }
    }
    const cf = buildCfHtml('<p>كِتَاب</p>')
    await make().paste(FG, 'كِتَاب', cf)
    expect(calls[0].req).toMatchObject({ cmd: 'paste', hwnd: 4242, restoreDelayMs: 700 })
    expect(seen).not.toBeNull()
    expect(parseCfHtml(readHtmlFormat(seen!) as Buffer).html).toContain('<p>كِتَاب</p>')
    expect(readUnicodeText(seen!)).toBe('كِتَاب')
    expect(seen!.find((e) => e.id === CF_UNICODETEXT)).toBeTruthy()
  })

  it('plain paste has only text', async () => {
    let seen: ReturnType<typeof decodeContainer> = null
    handler = (_s, req) => {
      seen = decodeContainer(readFileSync(req.contentPath as string))
      return { ok: true }
    }
    await make().paste(FG, 'نص')
    expect(seen!.map((e) => e.id)).toEqual([CF_UNICODETEXT])
  })

  it('paste failures keep the document untouched and are mapped', async () => {
    handler = () => ({ ok: false, error: 'focus_lost' })
    await expect(make().paste(FG, 'x')).rejects.toMatchObject({ code: 'focus_lost' })
    handler = () => ({ ok: false, error: 'elevated' })
    await expect(make().paste(FG, 'x')).rejects.toMatchObject({ code: 'elevated' })
    handler = () => ({ ok: true })
    await make().focus(FG)
    expect(calls.at(-1)?.req).toMatchObject({ cmd: 'focus', hwnd: 4242 })
  })
})

describe('privacy', () => {
  it('never puts the user text on the command line', async () => {
    const SECRET = 'نص-سري-للمستخدم'
    handler = (_s, req) => copied(req, [unicodeTextEntry(SECRET)])
    await make().capture()
    handler = () => ({ ok: true })
    await make().paste(FG, SECRET)
    await make().applyWordEdits(
      { kind: 'word', text: SECRET, start: 0, end: SECRET.length, fg: FG },
      [],
      SECRET.length
    )
    const argv = calls.flatMap((c) => c.args).join('\n')
    expect(argv).not.toContain(SECRET)
    expect(argv).not.toContain('سري')
    // only file paths and fixed flags
    for (const c of calls) {
      expect(c.args.slice(0, 5)).toEqual([
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File'
      ])
    }
  })

  it('deletes every temp file after success and after failure', async () => {
    handler = (_s, req) => copied(req, [unicodeTextEntry('نص')])
    await make().capture()
    expect(leftovers()).toEqual([])
    handler = () => ({ ok: false, error: 'elevated' })
    await make()
      .capture()
      .catch(() => undefined)
    handler = () => 'timeout'
    await make()
      .capture()
      .catch(() => undefined)
    handler = () => ({ ok: true })
    await make().paste(FG, 'نص')
    expect(leftovers()).toEqual([])
  })
})

describe('container', () => {
  it('round-trips and rejects malformed data without throwing', () => {
    const c = contentContainer('نص', buildCfHtml('<p>x</p>'))
    const back = decodeContainer(c)!
    expect(back.map((e) => [e.id, e.name])).toEqual([
      [0, HTML_FORMAT],
      [CF_UNICODETEXT, '']
    ])
    expect(readUnicodeText(back)).toBe('نص')
    expect(decodeContainer(Buffer.from('nope'))).toBeNull()
    expect(decodeContainer(c.subarray(0, c.length - 3))).toBeNull()
    expect(decodeContainer(Buffer.alloc(0))).toBeNull()
    expect(readUnicodeText([])).toBeNull()
  })

  it('reads UTF-16 text with and without the NUL terminator', () => {
    expect(
      readUnicodeText([{ id: CF_UNICODETEXT, name: '', data: Buffer.from('مرحبا\0', 'utf16le') }])
    ).toBe('مرحبا')
    expect(
      readUnicodeText([{ id: CF_UNICODETEXT, name: '', data: Buffer.from('مرحبا', 'utf16le') }])
    ).toBe('مرحبا')
  })
})
