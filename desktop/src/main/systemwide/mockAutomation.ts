import {
  AutomationError,
  type Automation,
  type AutomationErrorCode,
  type CapturedSelection,
  type FgInfo
} from './automation'
import { parseCfHtml } from './htmlText'
import type { TextEdit } from './textDiff'

/**
 * Test double for the Windows automation, used ONLY by the Playwright suite (unpackaged build with
 * MIZAJ_E2E_SYSTEMWIDE_MOCK=1): no keystrokes, no clipboard, no COM. The test scripts the selection
 * and reads back what would have been put into the program.
 */
export interface MockApplied {
  how: 'word' | 'paste'
  plain?: string
  html?: string
  edits?: TextEdit[]
}

export const MOCK_FG: FgInfo = { hwnd: 1, pid: 1, exe: 'mock.exe', elevated: false }

export class MockAutomation implements Automation {
  selection: CapturedSelection = { kind: 'plain', text: '', fg: MOCK_FG }
  error: AutomationErrorCode | null = null
  applied: MockApplied[] = []
  calls: string[] = []

  setPlain(text: string): void {
    this.selection = { kind: 'plain', text, fg: MOCK_FG }
  }
  setHtml(cfHtml: string, text: string): void {
    this.selection = { kind: 'html', text, cfHtml, extra: [], fg: MOCK_FG }
  }
  setWord(text: string): void {
    this.selection = { kind: 'word', text, start: 0, end: text.length, fg: MOCK_FG }
  }

  async capture(): Promise<CapturedSelection> {
    this.calls.push('capture')
    if (this.error) throw new AutomationError(this.error)
    return this.selection
  }
  async captureClipboard(): Promise<Exclude<CapturedSelection, { kind: 'word' }>> {
    this.calls.push('captureClipboard')
    if (this.selection.kind === 'word')
      return { kind: 'plain', text: this.selection.text, fg: MOCK_FG }
    return this.selection
  }
  async applyWordEdits(_s: unknown, edits: TextEdit[]): Promise<void> {
    this.calls.push('applyWord')
    this.applied.push({ how: 'word', edits })
  }
  async paste(_fg: FgInfo, plain: string, cfHtml?: Buffer): Promise<void> {
    this.calls.push('paste')
    this.applied.push({ how: 'paste', plain, html: cfHtml ? parseCfHtml(cfHtml).html : undefined })
  }
  async focus(): Promise<void> {
    this.calls.push('focus')
  }
}
