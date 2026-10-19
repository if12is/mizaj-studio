import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { contentContainer, decodeContainer, readHtmlFormat, readUnicodeText } from './container'
import { parseCfHtml, parseHtml } from './htmlText'
import type { TextEdit } from './textDiff'

/**
 * Windows automation for the system-wide feature: read the selection of the foreground program and
 * put the processed text back, preserving formatting.
 *
 *   path 1 (Word, best): COM helper (word.ps1) reads Selection.Range and applies minimal edits from the
 *          end backwards inside one Undo record, so every untouched character keeps its style.
 *   path 2 (any program): the rich clipboard. The full clipboard is saved, Ctrl+C is sent, the HTML
 *          (or plain text) is read; later the processed content is pasted with Ctrl+V and the original
 *          clipboard is restored.
 *
 * Both helpers are PowerShell scripts shipped in resources and started with execFile + an argument list.
 * The user's text is NEVER on the command line: it travels in files inside a private per-job folder
 * under <userData>/systemwide-tmp, deleted when the call ends (also on failure).
 */

export interface FgInfo {
  hwnd: number
  pid: number
  exe: string
  elevated: boolean
}

export type CapturedSelection =
  | { kind: 'word'; text: string; start: number; end: number; fg: FgInfo }
  | { kind: 'html'; text: string; cfHtml: string; extra: string[]; fg: FgInfo }
  | { kind: 'plain'; text: string; fg: FgInfo }

export type AutomationErrorCode =
  | 'unsupported'
  | 'no_window'
  | 'elevated'
  | 'terminal'
  | 'no_selection'
  | 'modifiers_held'
  | 'clipboard_busy'
  | 'helper_failed'
  | 'timeout'
  | 'focus_lost'
  | 'send_failed'
  | 'word_changed'
  | 'word_mismatch'
  | 'word_protected'
  | 'word_failed'

export const AUTOMATION_ERROR_AR: Record<AutomationErrorCode, string> = {
  unsupported: 'هذه الميزة تعمل على ويندوز فقط.',
  no_window: 'لا توجد نافذة نشطة لمعالجة نصها.',
  elevated:
    'البرنامج الذي تعمل عليه يعمل بصلاحيات المسؤول (Administrator) ويمنع ويندوز البرامج العادية من التحكم به. انسخ النص إلى محرر مِزَاج، أو شغّل مِزَاج بالصلاحيات نفسها.',
  terminal: 'نوافذ الطرفية (cmd وPowerShell) غير مدعومة لأن Ctrl+C فيها يوقف الأوامر الجارية.',
  no_selection: 'لم يُنسخ أي نص محدد. حدّد نصاً ثم أعد المحاولة.',
  modifiers_held: 'اترك مفاتيح الاختصار (Ctrl وAlt وShift) ثم أعد المحاولة.',
  clipboard_busy: 'الحافظة مشغولة ببرنامج آخر. أعد المحاولة بعد لحظة.',
  helper_failed: 'تعذّر تشغيل أداة التحكم بويندوز. لم يُغيَّر شيء.',
  timeout: 'استغرق الأمر وقتاً طويلاً وأُوقف. لم يُغيَّر شيء.',
  focus_lost: 'تعذّرت العودة إلى البرنامج الأصلي. لم يُستبدل النص.',
  send_failed: 'تعذّر إرسال أمر اللصق إلى البرنامج. لم يُستبدل النص.',
  word_changed: 'تغيّر مستند Word منذ قراءة التحديد. لم يُستبدل شيء؛ أعد المحاولة.',
  word_mismatch: 'تعذّر مطابقة التحديد مع مستند Word بدقة.',
  word_protected: 'مستند Word محمي (عرض محمي أو تقييد تحرير). فعّل التحرير أولاً.',
  word_failed: 'تعذّر على Word تطبيق التعديل، فأُلغيت التغييرات كلها.'
}

export class AutomationError extends Error {
  constructor(public readonly code: AutomationErrorCode) {
    super(code)
    this.name = 'AutomationError'
  }
  get messageAr(): string {
    return AUTOMATION_ERROR_AR[this.code]
  }
}

export interface Automation {
  /** Read the selection of the foreground program (Word through COM when possible, else the clipboard). */
  capture(): Promise<CapturedSelection>
  /** Read the selection through the clipboard only (the fallback when Word's offsets cannot be trusted). */
  captureClipboard(): Promise<Exclude<CapturedSelection, { kind: 'word' }>>
  applyWordEdits(
    sel: Extract<CapturedSelection, { kind: 'word' }>,
    edits: TextEdit[],
    newLength: number
  ): Promise<void>
  /** Put content on the clipboard, paste it into the program `fg`, restore the clipboard. */
  paste(fg: FgInfo, plain: string, cfHtml?: Buffer): Promise<void>
  /** Bring the program back to the foreground (after the popup closed). */
  focus(fg: FgInfo): Promise<void>
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide: true; maxBuffer: number }
) => Promise<void>

/** Word edits beyond this count are applied through the clipboard path instead (COM calls are slow). */
export const MAX_WORD_EDITS = 1500

interface HelperResponse {
  ok?: boolean
  error?: string
  word?: boolean
  copied?: boolean
  empty?: boolean
  consistent?: boolean
  text?: string
  start?: number
  end?: number
  fg?: { hwnd: number; pid: number; exe: string; elevated: boolean }
  [k: string]: unknown
}

const KNOWN: ReadonlySet<string> = new Set<AutomationErrorCode>([
  'no_window',
  'elevated',
  'terminal',
  'modifiers_held',
  'clipboard_busy',
  'focus_lost',
  'send_failed',
  'word_protected',
  'word_failed'
])

function mapError(code: string | undefined): AutomationError {
  if (code === 'changed') return new AutomationError('word_changed')
  if (code === 'mismatch') return new AutomationError('word_mismatch')
  if (code && KNOWN.has(code)) return new AutomationError(code as AutomationErrorCode)
  if (code === 'clipboard_busy') return new AutomationError('clipboard_busy')
  return new AutomationError('helper_failed')
}

/** Characters that signal Range offsets != Text indices (cell end marks, field markers, object/note anchors). */
// eslint-disable-next-line no-control-regex
const STRUCTURE_RE = /[\u0000-\u0008\u0013-\u0015]/

export interface WinAutomationOptions {
  /** <userData>/systemwide-tmp */
  tmpRoot: string
  /** <resources>/systemwide (winauto.ps1, word.ps1) */
  scriptsDir: string
  exec: ExecFn
  powershell?: string
  undoName?: string
  platform?: NodeJS.Platform
  /** ms to wait before restoring the clipboard after Ctrl+V */
  restoreDelayMs?: number
  newId?: () => string
}

export class WinAutomation implements Automation {
  private readonly ps: string
  constructor(private readonly o: WinAutomationOptions) {
    this.ps =
      o.powershell ??
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
  }

  private async withJob<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    if ((this.o.platform ?? process.platform) !== 'win32') throw new AutomationError('unsupported')
    mkdirSync(this.o.tmpRoot, { recursive: true, mode: 0o700 })
    const dir = mkdtempSync(join(this.o.tmpRoot, 'job-'))
    try {
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private async run(
    dir: string,
    script: 'winauto' | 'word',
    req: Record<string, unknown>,
    timeoutMs: number
  ): Promise<HelperResponse> {
    const stem = `${script}-${this.o.newId?.() ?? Math.random().toString(36).slice(2)}`
    const reqPath = join(dir, `${stem}.req.json`)
    const respPath = join(dir, `${stem}.resp.json`)
    writeFileSync(reqPath, JSON.stringify({ ...req, dir }), { encoding: 'utf8', mode: 0o600 })
    try {
      await this.o.exec(
        this.ps,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(this.o.scriptsDir, `${script}.ps1`),
          '-Request',
          reqPath,
          '-Response',
          respPath
        ],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }
      )
    } catch (e) {
      const x = e as { killed?: boolean; signal?: string | null; code?: string }
      if (x.killed || x.signal || x.code === 'ETIMEDOUT') throw new AutomationError('timeout')
      throw new AutomationError('helper_failed')
    }
    if (!existsSync(respPath)) throw new AutomationError('helper_failed')
    try {
      return JSON.parse(readFileSync(respPath, 'utf8')) as HelperResponse
    } catch {
      throw new AutomationError('helper_failed')
    }
  }

  private fgOf(r: HelperResponse): FgInfo {
    const f = r.fg
    return {
      hwnd: Number(f?.hwnd ?? 0),
      pid: Number(f?.pid ?? 0),
      exe: String(f?.exe ?? ''),
      elevated: !!f?.elevated
    }
  }

  async capture(): Promise<CapturedSelection> {
    return this.withJob(async (dir) => {
      const outPath = join(dir, 'selection.bin')
      const r = await this.run(dir, 'winauto', { cmd: 'capture', outPath, timeoutMs: 1500 }, 30_000)
      if (!r.ok) throw mapError(r.error)
      if (!r.word) return this.readCopied(r, outPath)
      const fg = this.fgOf(r)
      const w = await this.run(dir, 'word', { cmd: 'read' }, 30_000)
      if (w.ok && w.empty) throw new AutomationError('no_selection')
      if (w.error === 'word_protected') throw new AutomationError('word_protected')
      if (
        w.ok &&
        w.consistent &&
        typeof w.text === 'string' &&
        typeof w.start === 'number' &&
        typeof w.end === 'number' &&
        w.end - w.start === w.text.length &&
        !STRUCTURE_RE.test(w.text)
      )
        return { kind: 'word', text: w.text, start: w.start, end: w.end, fg }
      // COM unavailable, or Range offsets differ from Text indices (fields, tables, shapes...):
      // never risk corrupting the document, use the clipboard path instead
      return this.copyViaClipboard(dir, outPath)
    })
  }

  async captureClipboard(): Promise<Exclude<CapturedSelection, { kind: 'word' }>> {
    return this.withJob((dir) => this.copyViaClipboard(dir, join(dir, 'selection.bin')))
  }

  private async copyViaClipboard(
    dir: string,
    outPath: string
  ): Promise<Exclude<CapturedSelection, { kind: 'word' }>> {
    const r = await this.run(
      dir,
      'winauto',
      { cmd: 'capture', outPath, timeoutMs: 1500, forceCopy: true },
      30_000
    )
    if (!r.ok) throw mapError(r.error)
    return this.readCopied(r, outPath)
  }

  private readCopied(
    r: HelperResponse,
    outPath: string
  ): Exclude<CapturedSelection, { kind: 'word' }> {
    if (!r.copied) throw new AutomationError('no_selection')
    const fg = this.fgOf(r)
    const entries = decodeContainer(readFileSync(outPath))
    if (!entries) throw new AutomationError('helper_failed')
    const plain = readUnicodeText(entries)
    const raw = readHtmlFormat(entries)
    if (raw) {
      const cf = parseCfHtml(raw)
      const doc = parseHtml(cf.html)
      if (/\S/.test(doc.text))
        return { kind: 'html', text: doc.text, cfHtml: cf.html, extra: cf.extra, fg }
    }
    if (plain && /\S/.test(plain)) return { kind: 'plain', text: plain, fg }
    throw new AutomationError('no_selection')
  }

  async applyWordEdits(
    sel: Extract<CapturedSelection, { kind: 'word' }>,
    edits: TextEdit[],
    newLength: number
  ): Promise<void> {
    await this.withJob(async (dir) => {
      const r = await this.run(
        dir,
        'word',
        {
          cmd: 'apply',
          start: sel.start,
          end: sel.end,
          expected: sel.text,
          newLength,
          undoName: 'مِزَاج',
          edits: edits.map((e) => ({ s: e.start, e: e.end, ins: e.insert }))
        },
        120_000
      )
      if (!r.ok) throw mapError(r.error)
    })
  }

  async paste(fg: FgInfo, plain: string, cfHtml?: Buffer): Promise<void> {
    await this.withJob(async (dir) => {
      const contentPath = join(dir, 'content.bin')
      writeFileSync(contentPath, contentContainer(plain, cfHtml), { mode: 0o600 })
      const r = await this.run(
        dir,
        'winauto',
        { cmd: 'paste', contentPath, hwnd: fg.hwnd, restoreDelayMs: this.o.restoreDelayMs ?? 700 },
        30_000
      )
      if (!r.ok) throw mapError(r.error)
    })
  }

  async focus(fg: FgInfo): Promise<void> {
    await this.withJob(async (dir) => {
      const r = await this.run(dir, 'winauto', { cmd: 'focus', hwnd: fg.hwnd }, 15_000)
      if (!r.ok) throw mapError(r.error)
    })
  }
}
