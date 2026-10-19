import { describe, expect, it } from 'vitest'
import { AutomationError, type Automation, type CapturedSelection, type FgInfo } from './automation'
import { cloneDefault, type SystemwideConfig } from './config'
import { buildCfHtml, parseCfHtml } from './htmlText'
import type { PipelineDeps } from './pipeline'
import { SystemwideService, type PopupState } from './service'
import type { TextEdit } from './textDiff'

const FG: FgInfo = { hwnd: 77, pid: 5, exe: 'x.exe', elevated: false }
const TEXT = 'هذا كتاب جميل جدا'

const backend: PipelineDeps = {
  async proofread(text, cats) {
    const items = []
    if (cats.includes('ya') && text.includes('فى'))
      items.push({
        start: text.indexOf('فى'),
        end: text.indexOf('فى') + 2,
        original: 'فى',
        replacement: 'في',
        category: 'ya' as const
      })
    return { items }
  },
  async apply(text, items) {
    let out = text
    for (const it of [...items].sort((a, b) => b.start - a.start))
      out = out.slice(0, it.start) + it.replacement + out.slice(it.end)
    return { text: out, applied: items.length, skipped: 0 }
  },
  async tashkeel(text) {
    return { text: text.replace(/كتاب/g, 'كِتَابٌ') }
  }
}

class FakeAuto implements Automation {
  calls: string[] = []
  pasted: { plain: string; html?: string }[] = []
  wordEdits: { edits: TextEdit[]; newLength: number }[] = []
  captureErr: AutomationError | null = null
  wordErr: AutomationError | null = null
  constructor(
    public sel: CapturedSelection,
    public clipSel?: Exclude<CapturedSelection, { kind: 'word' }>
  ) {}
  async capture(): Promise<CapturedSelection> {
    this.calls.push('capture')
    if (this.captureErr) throw this.captureErr
    return this.sel
  }
  async captureClipboard(): Promise<Exclude<CapturedSelection, { kind: 'word' }>> {
    this.calls.push('captureClipboard')
    return this.clipSel as never
  }
  async applyWordEdits(_s: unknown, edits: TextEdit[], newLength: number): Promise<void> {
    this.calls.push('applyWord')
    if (this.wordErr) throw this.wordErr
    this.wordEdits.push({ edits, newLength })
  }
  async paste(_fg: FgInfo, plain: string, cfHtml?: Buffer): Promise<void> {
    this.calls.push('paste')
    this.pasted.push({ plain, html: cfHtml ? parseCfHtml(cfHtml).html : undefined })
  }
  async focus(): Promise<void> {
    this.calls.push('focus')
  }
}

function setup(
  sel: CapturedSelection,
  cfg: Partial<SystemwideConfig> = {},
  clip?: Exclude<CapturedSelection, { kind: 'word' }>
) {
  const auto = new FakeAuto(sel, clip)
  const states: PopupState[] = []
  const notes: { m: string; k: string }[] = []
  const logs: string[] = []
  const popup = { shown: 0, hidden: 0 }
  const svc = new SystemwideService({
    automation: auto,
    backend,
    getConfig: () => ({ ...cloneDefault(), enabled: true, ...cfg }),
    hooks: {
      onState: (s) => states.push(s),
      showPopup: () => void popup.shown++,
      hidePopup: () => void popup.hidden++,
      notify: (m, k) => void notes.push({ m, k }),
      log: (e) => void logs.push(e)
    }
  })
  return { auto, svc, states, notes, logs, popup }
}

const plainSel = (text = TEXT): CapturedSelection => ({ kind: 'plain', text, fg: FG })
const htmlSel = (html: string): CapturedSelection => ({
  kind: 'html',
  text: 'x',
  cfHtml: buildCfHtml(html)
    .toString('utf8')
    .replace(/^[\s\S]*?(<html)/, '$1'),
  extra: [],
  fg: FG
})
const wordSel = (text = TEXT): CapturedSelection => ({
  kind: 'word',
  text,
  start: 10,
  end: 10 + text.length,
  fg: FG
})

describe('main shortcut: popup with 4 operations', () => {
  it('captures, shows the popup in the choose phase, then previews and replaces', async () => {
    const t = setup(plainSel())
    await t.svc.trigger('main')
    expect(t.popup.shown).toBe(1)
    expect(t.states.at(-1)).toMatchObject({
      phase: 'choose',
      source: 'plain',
      chars: TEXT.length,
      mode: 'preview'
    })
    expect(t.states.at(-1)?.snippet).toBe(TEXT)

    await t.svc.run('tashkeel')
    const prev = t.states.at(-1) as PopupState
    expect(prev.phase).toBe('preview')
    expect(prev.changed).toBe(true)
    expect(prev.segments.map((s) => s.text).join('')).toBe('هذا كِتَابٌ جميل جدا')
    expect(t.auto.pasted).toEqual([]) // nothing is replaced before the user confirms

    await t.svc.apply()
    expect(t.auto.pasted).toEqual([{ plain: 'هذا كِتَابٌ جميل جدا' }])
    expect(t.auto.calls).toEqual(['capture', 'focus', 'paste'])
    expect(t.popup.hidden).toBeGreaterThan(0)
    expect(t.notes.at(-1)).toMatchObject({ k: 'info' })
    expect(t.svc.active).toBe(false)
  })

  it('another operation can be chosen after the preview (keys 1-4)', async () => {
    const t = setup(plainSel('قال كتاب فى الدار'))
    await t.svc.trigger('main')
    await t.svc.run('tashkeel')
    await t.svc.run('proofread')
    const prev = t.states.at(-1) as PopupState
    expect(prev.op).toBe('proofread')
    expect(prev.segments.map((s) => s.text).join('')).toBe('قال كتاب في الدار')
  })

  it('ignores unknown operations and runs while nothing was captured', async () => {
    const t = setup(plainSel())
    await t.svc.run('tashkeel')
    expect(t.states).toEqual([])
    await t.svc.trigger('main')
    await t.svc.run('evil')
    expect(t.states.at(-1)?.phase).toBe('choose')
  })

  it('cancel hides the popup, returns focus and drops the text', async () => {
    const t = setup(plainSel())
    await t.svc.trigger('main')
    t.svc.cancel()
    expect(t.svc.active).toBe(false)
    expect(t.auto.pasted).toEqual([])
    await new Promise((r) => setTimeout(r))
    expect(t.auto.calls).toContain('focus')
  })

  it('pressing the shortcut again while the popup is open refocuses the program before copying', async () => {
    const t = setup(plainSel())
    await t.svc.trigger('main')
    await t.svc.trigger('main')
    expect(t.auto.calls).toEqual(['capture', 'focus', 'capture'])
  })
})

describe('operation shortcuts', () => {
  it('preview mode (default): shows the popup with the result, replaces only on confirmation', async () => {
    const t = setup(plainSel())
    await t.svc.trigger('tashkeel')
    expect(t.popup.shown).toBe(1)
    expect(t.states.at(-1)).toMatchObject({ phase: 'preview', op: 'tashkeel' })
    expect(t.auto.pasted).toEqual([])
    await t.svc.apply()
    expect(t.auto.pasted.length).toBe(1)
  })

  it('direct mode: replaces at once with no popup, then notifies', async () => {
    const t = setup(plainSel(), { replaceMode: 'direct' })
    await t.svc.trigger('tashkeel')
    expect(t.popup.shown).toBe(0)
    expect(t.auto.pasted).toEqual([{ plain: 'هذا كِتَابٌ جميل جدا' }])
    expect(t.notes.at(-1)?.k).toBe('info')
  })

  it('direct mode with the main shortcut: choosing a button replaces immediately', async () => {
    const t = setup(plainSel(), { replaceMode: 'direct' })
    await t.svc.trigger('main')
    expect(t.auto.pasted).toEqual([])
    await t.svc.run('tashkeel')
    expect(t.auto.pasted.length).toBe(1)
  })

  it('tells the user when nothing changes and does not touch the program', async () => {
    const t = setup(plainSel('هذا كتاب جميل جدا'), { replaceMode: 'direct' })
    await t.svc.trigger('punctuation')
    expect(t.auto.pasted).toEqual([])
    expect(t.notes.at(-1)?.m).toContain('لا توجد تغييرات')
  })

  it('shows the short-text warning for tashkeel', async () => {
    const t = setup(plainSel('كتاب جميل'))
    await t.svc.trigger('tashkeel')
    expect(t.states.at(-1)?.warnings[0]).toContain('النص قصير')
  })
})

describe('errors', () => {
  it('capture errors are shown as a notification with the Arabic message', async () => {
    const t = setup(plainSel())
    t.auto.captureErr = new AutomationError('elevated')
    await t.svc.trigger('main')
    expect(t.popup.shown).toBe(0)
    expect(t.notes.at(-1)).toMatchObject({ k: 'error' })
    expect(t.notes.at(-1)?.m).toContain('Administrator')
    expect(t.logs).toContain('error:elevated')
    t.auto.captureErr = new AutomationError('no_selection')
    await t.svc.trigger('tashkeel')
    expect(t.notes.at(-1)?.m).toBe('لم يُنسخ أي نص محدد. حدّد نصاً ثم أعد المحاولة.')
  })

  it('non-Arabic selections are refused with a clear message in the popup', async () => {
    const t = setup(plainSel('hello'))
    await t.svc.trigger('main')
    await t.svc.run('all')
    expect(t.states.at(-1)).toMatchObject({ phase: 'error', error: 'لا يوجد نص عربي في التحديد.' })
  })

  it('a failed replacement keeps the selection and reports it', async () => {
    const t = setup(plainSel())
    t.auto.paste = async () => {
      throw new AutomationError('focus_lost')
    }
    await t.svc.trigger('tashkeel')
    await t.svc.apply()
    expect(t.states.at(-1)).toMatchObject({ phase: 'error' })
    expect(t.states.at(-1)?.error).toContain('العودة إلى البرنامج الأصلي')
  })

  it('never logs the text', async () => {
    const t = setup(plainSel())
    await t.svc.trigger('tashkeel')
    await t.svc.apply()
    expect(t.logs.join(' ')).not.toContain('كتاب')
    expect(t.logs.join(' ')).toContain('applied:tashkeel:plain')
  })
})

describe('Word (COM) path', () => {
  it('applies minimal edits only, with the paragraph marks untouched', async () => {
    const text = 'هذا كتاب\rجميل جدا'
    const t = setup(wordSel(text), { replaceMode: 'direct' })
    await t.svc.trigger('tashkeel')
    expect(t.auto.calls).toEqual(['capture', 'focus', 'applyWord'])
    const { edits, newLength } = t.auto.wordEdits[0]
    expect(edits).toEqual([
      { start: 5, end: 5, insert: 'ِ' },
      { start: 6, end: 6, insert: 'َ' },
      { start: 8, end: 8, insert: 'ٌ' }
    ])
    expect(newLength).toBe(text.length + 3)
    expect(edits.every((e) => !/[\r\n]/.test(e.insert) && e.start === e.end)).toBe(true)
  })

  it('a mismatch reported by the helper falls back to the rich clipboard, redoing the operation', async () => {
    const clip: Exclude<CapturedSelection, { kind: 'word' }> = { kind: 'plain', text: TEXT, fg: FG }
    const t = setup(wordSel(), { replaceMode: 'direct' }, clip)
    t.auto.wordErr = new AutomationError('word_mismatch')
    await t.svc.trigger('tashkeel')
    expect(t.auto.calls).toEqual(['capture', 'focus', 'applyWord', 'captureClipboard', 'paste'])
    expect(t.auto.pasted[0].plain).toBe('هذا كِتَابٌ جميل جدا')
  })

  it('a changed document is NOT papered over with a fallback', async () => {
    const t = setup(wordSel(), { replaceMode: 'direct' })
    t.auto.wordErr = new AutomationError('word_changed')
    await t.svc.trigger('tashkeel')
    expect(t.auto.calls).not.toContain('paste')
    expect(t.notes.at(-1)).toMatchObject({ k: 'error' })
    expect(t.notes.at(-1)?.m).toContain('تغيّر مستند Word')
  })

  it('too many edits for COM use the clipboard path', async () => {
    const words = Array.from({ length: 1600 }, () => 'كتاب').join(' ')
    const clip: Exclude<CapturedSelection, { kind: 'word' }> = {
      kind: 'plain',
      text: words,
      fg: FG
    }
    const t = setup(wordSel(words), { replaceMode: 'direct' }, clip)
    await t.svc.trigger('tashkeel')
    expect(t.auto.calls).toEqual(['capture', 'focus', 'captureClipboard', 'paste'])
  })
})

describe('rich clipboard path', () => {
  const html =
    '<html><body><!--StartFragment--><p class=MsoNormal><b style="color:red">كتاب</b> <i>جديد</i> جدا اليوم</p><!--EndFragment--></body></html>'

  it('transforms only the text nodes and pastes HTML plus plain text', async () => {
    const t = setup(htmlSel(html), { replaceMode: 'direct' })
    await t.svc.trigger('tashkeel')
    const p = t.auto.pasted[0]
    expect(p.html).toContain(
      '<p class=MsoNormal><b style="color:red">كِتَابٌ</b> <i>جديد</i> جدا اليوم</p>'
    )
    expect(p.plain).toBe('كِتَابٌ جديد جدا اليوم')
  })

  it('keeps paragraph breaks in the plain companion as CRLF', async () => {
    const h =
      '<html><body><!--StartFragment--><p>كتاب جميل</p><p>جدا اليوم</p><!--EndFragment--></body></html>'
    const t = setup(htmlSel(h), { replaceMode: 'direct' })
    await t.svc.trigger('tashkeel')
    expect(t.auto.pasted[0].plain).toBe('كِتَابٌ جميل\r\nجدا اليوم')
    expect(t.auto.pasted[0].html).toContain('<p>جدا اليوم</p>')
  })

  it('plain text keeps its CRLF line endings', async () => {
    const t = setup(plainSel('هذا كتاب\r\nجميل جدا'), { replaceMode: 'direct' })
    await t.svc.trigger('tashkeel')
    expect(t.auto.pasted[0].plain).toBe('هذا كِتَابٌ\r\nجميل جدا')
  })
})
