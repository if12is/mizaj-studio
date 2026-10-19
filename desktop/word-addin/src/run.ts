import { stripMarks } from '../../src/main/systemwide/arabic'
import {
  applyEdits as applyTextEdits,
  type PreviewSegment,
  type TextEdit
} from '../../src/main/systemwide/textDiff'
import { AddinApiError, type Api, type OpId, type ProcessResponse } from './api'
import { applyParagraphEdits, type ApplyReport } from './apply'
import { SKIP_REASON_AR, type SkipReason } from './plan'
import { readSelection } from './selection'
import type { WordHost } from './types'

export const OP_LABEL_AR: Record<OpId, string> = {
  proofread: 'التدقيق الإملائي',
  punctuation: 'الترقيم',
  tashkeel: 'التشكيل',
  all: 'التدقيق والترقيم والتشكيل'
}

export class RunError extends Error {
  constructor(
    public readonly code: string,
    public readonly messageAr: string
  ) {
    super(code)
    this.name = 'RunError'
  }
}

/** What the selection looked like when the preview was made. */
export interface Preview {
  op: OpId
  /** full text of every selection paragraph, to detect that the document changed meanwhile */
  allTexts: string[]
  /** indexes (into allTexts) of the paragraphs that were sent to the engine */
  eligible: number[]
  skipped: Partial<Record<SkipReason, number>>
  response: ProcessResponse
  segments: PreviewSegment[]
  warnings: string[]
  changed: boolean
}

export interface ApplyOutcome {
  report: ApplyReport
  /** Arabic status lines for the user */
  messages: string[]
}

export interface RunnerDeps {
  host: WordHost
  api: Api
  /** WordApi 1.4 (fields / content controls on paragraphs) available */
  supported: () => boolean
}

function skippedNotes(skipped: Preview['skipped']): string[] {
  const out: string[] = []
  for (const k of Object.keys(skipped) as SkipReason[]) {
    if (k === 'empty' || !skipped[k]) continue
    out.push(`تُركت ${skipped[k]} ${SKIP_REASON_AR[k]} كما هي.`)
  }
  return out
}

/** Defence in depth on the response, whatever the server sent. */
function validateResponse(op: OpId, texts: string[], edits: TextEdit[][]): void {
  texts.forEach((t, i) => {
    let pos = 0
    for (const e of edits[i]) {
      if (!(e.start >= pos && e.end >= e.start && e.end <= t.length) || /[\r\n]/.test(e.insert))
        throw new RunError('bad_edits', 'ردّ غير متوقع من مِزَاج. لم يُغيَّر النص.')
      pos = e.end
    }
    if (op === 'tashkeel') {
      // tashkeel may only add / change marks, never base letters
      const r = applyTextEdits(t, edits[i])
      if (stripMarks(r) !== stripMarks(t))
        throw new RunError(
          'base_changed',
          'رُفضت نتيجة التشكيل لأنها غيّرت حروفاً أساسية. لم يُغيَّر النص.'
        )
    }
  })
}

export class Runner {
  constructor(private readonly d: RunnerDeps) {}

  private requireSupport(): void {
    if (!this.d.supported())
      throw new RunError(
        'unsupported',
        'إصدار Word لا يدعم هذه الإضافة (يلزم WordApi 1.4: Word 2016 الحديث أو Microsoft 365).'
      )
  }

  /** Reads the selection and asks the engine what would change. Writes nothing. */
  async preview(op: OpId): Promise<Preview> {
    this.requireSupport()
    const read = await this.d.host.run((ctx) => readSelection(ctx))
    if (read.empty || !read.paras.some((p) => p.skip === null))
      throw new RunError(
        read.empty ? 'empty' : 'nothing',
        read.empty
          ? 'حدّد نصاً عربياً في المستند أولاً.'
          : 'لا يوجد في التحديد نص يمكن معالجته (فقرات فارغة أو تحتوي حقولاً أو عناصر تحكم).'
      )
    const allTexts = read.paras.map((p) => p.text)
    const eligible: number[] = []
    const skipped: Preview['skipped'] = {}
    read.paras.forEach((p, i) => {
      if (p.skip === null) eligible.push(i)
      else skipped[p.skip] = (skipped[p.skip] ?? 0) + 1
    })
    const sent = eligible.map((i) => allTexts[i])
    const response = await this.d.api.process(op, sent)
    validateResponse(op, sent, response.edits)
    return {
      op,
      allTexts,
      eligible,
      skipped,
      response,
      segments: response.segments,
      warnings: response.warnings,
      changed: response.changed
    }
  }

  /** Writes a previewed result. The selection must still hold the same text. */
  async apply(p: Preview): Promise<ApplyOutcome> {
    this.requireSupport()
    if (!p.changed)
      return {
        report: { edited: 0, unmapped: 0, tooLarge: 0, verifyFailed: false },
        messages: ['لا توجد تغييرات: النص سليم كما هو.']
      }
    const report = await this.d.host.run(async (ctx) => {
      const read = await readSelection(ctx)
      const same =
        !read.empty &&
        read.paras.length === p.allTexts.length &&
        read.paras.every((x, i) => x.text === p.allTexts[i])
      if (!same)
        throw new RunError(
          'stale',
          'تغيّر التحديد أو النص منذ المعاينة. أعد المعاينة ثم اضغط «استبدال».'
        )
      const byPara = new Map<number, TextEdit[]>()
      p.eligible.forEach((paraIdx, k) => byPara.set(paraIdx, p.response.edits[k]))
      return applyParagraphEdits(ctx, read.paras, byPara)
    })
    const messages: string[] = []
    if (report.edited > 0)
      messages.push(
        `تم الاستبدال («${OP_LABEL_AR[p.op]}») في ${report.edited} فقرة مع بقاء التنسيق.`
      )
    messages.push(...skippedNotes(p.skipped))
    if (report.unmapped)
      messages.push(`تعذّر مطابقة حروف ${report.unmapped} فقرة مع Word، فتُركت دون تغيير.`)
    if (report.tooLarge)
      messages.push(`التحديد كبير: تُركت ${report.tooLarge} فقرة. حدّد جزءاً أصغر وأعد المحاولة.`)
    if (report.verifyFailed)
      messages.push(
        'تنبيه: لم يطابق النص بعد التعديل ما كان متوقعاً. اضغط Ctrl+Z في Word للتراجع وأبلغ عن المشكلة.'
      )
    return { report, messages }
  }

  /** The ribbon buttons: preview and replace in one go. */
  async runDirect(op: OpId): Promise<{ preview: Preview; outcome: ApplyOutcome }> {
    const preview = await this.preview(op)
    const outcome = await this.apply(preview)
    return { preview, outcome }
  }
}

/** Arabic message for any error, never containing document text. */
export function messageOf(e: unknown): string {
  if (e instanceof RunError || e instanceof AddinApiError) return e.messageAr
  return 'تعذّر تنفيذ العملية في Word. لم يُغيَّر النص.'
}
