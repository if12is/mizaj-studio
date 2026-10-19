import {
  AutomationError,
  MAX_WORD_EDITS,
  type Automation,
  type CapturedSelection,
  type FgInfo
} from './automation'
import { BackendError } from './backend'
import type { SystemwideConfig } from './config'
import { applyEditsToHtml, buildCfHtml, parseHtml } from './htmlText'
import {
  OP_IDS,
  OP_LABEL_AR,
  PipelineError,
  WARNING_AR,
  runOp,
  type OpId,
  type PipelineDeps,
  type PipelineResult
} from './pipeline'
import { diffText, previewSegments, type PreviewSegment, type TextEdit } from './textDiff'

/**
 * Orchestrates one «مِزَاج في أي برنامج» interaction: capture the selection, run an operation,
 * preview (optionally), replace. Pure of Electron: the popup, notifications and the OS automation
 * are injected, so the whole flow is unit-tested with fakes. The selected text is held in memory for
 * the duration of one interaction only; it is never logged or written to disk by this module.
 */

export type PopupPhase = 'choose' | 'running' | 'preview' | 'applying' | 'error'

export interface PopupState {
  phase: PopupPhase
  op: OpId | null
  /** how the text will be put back: Word (formatting kept, one Undo), rich clipboard, plain text */
  source: 'word' | 'html' | 'plain'
  chars: number
  snippet: string
  segments: PreviewSegment[]
  changed: boolean
  warnings: string[]
  error: string | null
  mode: 'preview' | 'direct'
}

export interface ServiceHooks {
  onState(s: PopupState): void
  showPopup(): void
  hidePopup(): void
  /** transient system notification (never contains the text) */
  notify(message: string, kind: 'info' | 'error'): void
  /** diagnostics: codes only, never text */
  log(event: string): void
}

export interface ServiceDeps {
  automation: Automation
  backend: PipelineDeps
  getConfig: () => SystemwideConfig
  hooks: ServiceHooks
}

type Plan =
  | { kind: 'word'; edits: TextEdit[]; newLength: number }
  | { kind: 'html'; cfHtml: Buffer; plain: string }
  | { kind: 'plain'; text: string }

interface Session {
  sel: CapturedSelection
  op: OpId | null
  result: PipelineResult | null
  plan: Plan | null
  changed: boolean
  state: PopupState
}

const SNIPPET = 140

const sourceOf = (s: CapturedSelection): PopupState['source'] =>
  s.kind === 'word' ? 'word' : s.kind === 'html' ? 'html' : 'plain'

/** Word text uses \r for paragraph marks; the engine sees \n. */
const toEngine = (s: string): string => s.replace(/\r\n?/g, '\n')

export class SystemwideService {
  private session: Session | null = null
  private busy = false

  constructor(private readonly d: ServiceDeps) {}

  get active(): boolean {
    return this.session !== null
  }

  getState(): PopupState | null {
    return this.session?.state ?? null
  }

  private emit(patch: Partial<PopupState>): void {
    if (!this.session) return
    this.session.state = { ...this.session.state, ...patch }
    this.d.hooks.onState(this.session.state)
  }

  private fail(e: unknown, popup: boolean): void {
    const msg = this.messageOf(e)
    this.d.hooks.log(`error:${this.codeOf(e)}`)
    if (popup && this.session) {
      this.emit({ phase: 'error', error: msg })
      this.d.hooks.showPopup()
    } else {
      this.d.hooks.notify(msg, 'error')
      this.session = null
    }
  }

  private codeOf(e: unknown): string {
    if (e instanceof AutomationError || e instanceof PipelineError || e instanceof BackendError)
      return e.code
    return 'unexpected'
  }

  private messageOf(e: unknown): string {
    if (e instanceof AutomationError) return e.messageAr
    if (e instanceof PipelineError || e instanceof BackendError) return e.messageAr
    return 'حدث خطأ غير متوقع. لم يُغيَّر النص.'
  }

  /** A shortcut was pressed: the main one (popup with the 4 buttons) or one of the four operations. */
  async trigger(origin: 'main' | OpId): Promise<void> {
    if (this.busy) {
      this.d.hooks.log('ignored:busy')
      return
    }
    this.busy = true
    try {
      if (this.session) {
        // pressed again while the popup is open: give the focus back first, or Ctrl+C would go to the popup
        const prev = this.session
        this.session = null
        this.d.hooks.hidePopup()
        await this.d.automation.focus(prev.sel.fg).catch(() => undefined)
      }
      const cfg = this.d.getConfig()
      let sel: CapturedSelection
      try {
        sel = await this.d.automation.capture()
      } catch (e) {
        this.fail(e, false)
        return
      }
      this.session = {
        sel,
        op: null,
        result: null,
        plan: null,
        changed: false,
        state: {
          phase: 'choose',
          op: null,
          source: sourceOf(sel),
          chars: sel.text.length,
          snippet: sel.text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET),
          segments: [],
          changed: false,
          warnings: [],
          error: null,
          mode: cfg.replaceMode
        }
      }
      if (origin === 'main') {
        this.d.hooks.onState(this.session.state)
        this.d.hooks.showPopup()
        return
      }
      if (cfg.replaceMode === 'preview') {
        this.d.hooks.onState(this.session.state)
        this.d.hooks.showPopup()
      }
      await this.runInner(origin, cfg.replaceMode === 'direct')
    } finally {
      this.busy = false
    }
  }

  /** The user chose an operation in the popup (button or key 1-4). */
  async run(op: unknown): Promise<void> {
    if (!OP_IDS.includes(op as OpId) || !this.session || this.busy) return
    this.busy = true
    try {
      await this.runInner(op as OpId, this.d.getConfig().replaceMode === 'direct')
    } finally {
      this.busy = false
    }
  }

  private async runInner(op: OpId, thenApply: boolean): Promise<void> {
    const s = this.session
    if (!s) return
    this.emit({ phase: 'running', op, error: null, warnings: [], segments: [], changed: false })
    try {
      await this.process(s, op)
    } catch (e) {
      this.fail(e, !thenApply)
      return
    }
    this.emit({
      phase: 'preview',
      op,
      segments: s.changed ? previewSegments(toEngine(s.sel.text), s.result?.text ?? '') : [],
      changed: s.changed,
      warnings: (s.result?.warnings ?? []).map((w) => WARNING_AR[w])
    })
    if (thenApply) await this.applyInner(true)
  }

  /** Run the pipeline and build the minimal way to put the result back. */
  private async process(s: Session, op: OpId): Promise<void> {
    const sel = s.sel
    const htmlDoc = sel.kind === 'html' ? parseHtml(sel.cfHtml) : null
    const result = await runOp(op, toEngine(htmlDoc ? htmlDoc.text : sel.text), this.d.backend)
    s.op = op
    s.result = result
    if (sel.kind === 'word') {
      const processed = result.text.replace(/\n/g, '\r')
      const edits = diffText(sel.text, processed)
      s.changed = edits.length > 0
      s.plan = { kind: 'word', edits, newLength: processed.length }
    } else if (sel.kind === 'html') {
      const doc = htmlDoc as NonNullable<typeof htmlDoc>
      const edits = diffText(doc.text, result.text)
      const html = applyEditsToHtml(doc, edits)
      s.changed = html !== sel.cfHtml
      s.plan = {
        kind: 'html',
        cfHtml: buildCfHtml(html, sel.extra),
        plain: result.text.replace(/\n/g, '\r\n')
      }
    } else {
      const crlf = sel.text.includes('\r\n')
      const out = crlf ? result.text.replace(/\n/g, '\r\n') : result.text
      s.changed = out !== sel.text
      s.plan = { kind: 'plain', text: out }
    }
  }

  /** «استبدال» (or Enter) in the popup. */
  async apply(): Promise<void> {
    if (this.busy || !this.session?.plan) return
    this.busy = true
    try {
      await this.applyInner(false)
    } finally {
      this.busy = false
    }
  }

  private async applyInner(direct: boolean): Promise<void> {
    const s = this.session
    if (!s || !s.plan || !s.op) return
    if (!s.changed) {
      this.d.hooks.hidePopup()
      this.d.hooks.notify('لا توجد تغييرات: النص سليم كما هو.', 'info')
      this.session = null
      return
    }
    this.emit({ phase: 'applying' })
    this.d.hooks.hidePopup() // the popup must not keep the focus the target program needs
    const fg: FgInfo = s.sel.fg
    try {
      await this.d.automation.focus(fg).catch(() => undefined) // Windows usually returns focus by itself
      await this.putBack(s, fg)
    } catch (e) {
      this.fail(e, !direct)
      return
    }
    this.d.hooks.log(`applied:${s.op}:${s.plan.kind}`)
    this.d.hooks.notify(`تم الاستبدال («${OP_LABEL_AR[s.op]}»).`, 'info')
    this.session = null
  }

  private async putBack(s: Session, fg: FgInfo): Promise<void> {
    const plan = s.plan as Plan
    if (plan.kind === 'word' && s.sel.kind === 'word') {
      if (plan.edits.length <= MAX_WORD_EDITS) {
        try {
          await this.d.automation.applyWordEdits(s.sel, plan.edits, plan.newLength)
          return
        } catch (e) {
          // a mismatch (not a changed document) is the signal to use the clipboard path instead
          if (!(e instanceof AutomationError) || e.code !== 'word_mismatch') throw e
        }
      }
      // too many edits for COM, or the helper refused: redo the operation on the rich clipboard
      const sel2 = await this.d.automation.captureClipboard()
      const s2: Session = { ...s, sel: sel2, plan: null, changed: false }
      await this.process(s2, s.op as OpId)
      if (!s2.changed || !s2.plan) return
      await this.pasteWith(s2.plan, fg)
      return
    }
    await this.pasteWith(plan, fg)
  }

  private async pasteWith(plan: Plan, fg: FgInfo): Promise<void> {
    if (plan.kind === 'html') await this.d.automation.paste(fg, plan.plain, plan.cfHtml)
    else if (plan.kind === 'plain') await this.d.automation.paste(fg, plan.text)
    else throw new AutomationError('word_mismatch')
  }

  /** «إلغاء» / Esc / click away. */
  cancel(refocus = true): void {
    const s = this.session
    this.session = null
    this.d.hooks.hidePopup()
    if (s && refocus) void this.d.automation.focus(s.sel.fg).catch(() => undefined)
  }
}
