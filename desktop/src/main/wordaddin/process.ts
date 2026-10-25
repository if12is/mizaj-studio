import {
  MAX_SELECTION_CHARS,
  PipelineError,
  OP_IDS,
  WARNING_AR,
  runOp,
  type OpId,
  type PipelineDeps,
  type PipelineResult
} from '../systemwide/pipeline'
import {
  applyEdits,
  diffText,
  previewSegments,
  type PreviewSegment,
  type TextEdit
} from '../systemwide/textDiff'

/**
 * What the Word add-in asks the main process to do, as pure functions over injected backend calls.
 * The add-in sends the selection's paragraphs (plain text, Word's own paragraph split); the answer
 * is a list of minimal edits PER PARAGRAPH (offsets are UTF-16 units of that paragraph's text, the
 * unit Word's ranges use), computed with the same diff the system-wide feature uses. The add-in
 * maps those edits onto character ranges so the formatting of every untouched character survives.
 */

export const MAX_PARAGRAPHS = 20_000

export interface ProcessRequest {
  op: OpId
  paragraphs: string[]
}

export interface ProcessOk {
  ok: true
  changed: boolean
  /** one edit list per request paragraph, local offsets */
  edits: TextEdit[][]
  segments: PreviewSegment[]
  warnings: string[]
  applied: { proofread: number; punctuation: number }
  tashkeelRan: boolean
}

export class ProcessError extends Error {
  constructor(
    public readonly code: 'bad_request' | 'unmappable',
    public readonly messageAr: string
  ) {
    super(code)
    this.name = 'ProcessError'
  }
}

/** Strict validation of the untrusted JSON body. */
export function parseProcessRequest(body: unknown): ProcessRequest | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.op !== 'string' || !OP_IDS.includes(b.op as OpId)) return null
  if (!Array.isArray(b.paragraphs) || b.paragraphs.length === 0) return null
  if (b.paragraphs.length > MAX_PARAGRAPHS) return null
  let total = 0
  for (const p of b.paragraphs) {
    if (typeof p !== 'string') return null
    // Word paragraph text has no line separators of its own; "\n" would break the mapping
    if (/[\n\r]/.test(p)) return null
    total += p.length + 1
    if (total > MAX_SELECTION_CHARS + MAX_PARAGRAPHS) return null
  }
  return { op: b.op as OpId, paragraphs: b.paragraphs as string[] }
}

/**
 * Splits edits computed on `paragraphs.join('\n')` into per-paragraph edits. Returns null when an
 * edit touches a paragraph separator or spans paragraphs (it cannot be applied inside one Word
 * paragraph), in which case nothing must be applied.
 */
export function splitEditsByParagraph(
  paragraphs: readonly string[],
  edits: readonly TextEdit[]
): TextEdit[][] | null {
  const out: TextEdit[][] = paragraphs.map(() => [])
  const starts: number[] = []
  let pos = 0
  for (const p of paragraphs) {
    starts.push(pos)
    pos += p.length + 1
  }
  let pi = 0
  for (const e of edits) {
    while (pi < paragraphs.length - 1 && e.start >= starts[pi + 1]) pi++
    const s = starts[pi]
    const end = s + paragraphs[pi].length
    if (e.start < s || e.end > end) return null
    out[pi].push({ start: e.start - s, end: e.end - s, insert: e.insert })
  }
  // an inserted text must not carry a separator either
  for (const list of out) for (const e of list) if (/[\n\r]/.test(e.insert)) return null
  return out
}

const cp = (c: string | undefined): string =>
  c === undefined ? '-' : 'U+' + (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')

/**
 * Per-paragraph edits when the processed text still has one line per paragraph: each paragraph is
 * diffed against its own line, so no edit can ever touch a separator. Null when the line count
 * changed (the engine merged or split lines).
 */
export function editsByLines(
  paragraphs: readonly string[],
  processed: string
): TextEdit[][] | null {
  const lines = processed.split('\n')
  if (lines.length !== paragraphs.length) return null
  return paragraphs.map((p, i) => diffText(p, lines[i]))
}

export async function processParagraphs(
  req: ProcessRequest,
  deps: PipelineDeps
): Promise<ProcessOk> {
  const joined = req.paragraphs.join('\n')
  const r = await runOp(req.op, joined, deps)
  const edits = diffText(joined, r.text)
  let per = splitEditsByParagraph(req.paragraphs, edits)
  let segments = edits.length ? previewSegments(joined, r.text) : []
  let changed = edits.length > 0
  if (!per) {
    // an edit crossed a paragraph separator (e.g. the diff paired whitespace around a line break):
    // diff line by line instead; that is exact whenever the engine kept the line count
    per = editsByLines(req.paragraphs, r.text)
    if (per) {
      changed = per.some((l) => l.length > 0)
      segments = changed ? previewSegments(joined, r.text) : []
    }
  }
  if (!per) {
    // the engine changed the line count: process every paragraph on its own (only code points are
    // ever reported, never text)
    const parts: PipelineResult[] = []
    for (const p of req.paragraphs) {
      if (/\S/.test(p)) {
        try {
          parts.push(await runOp(req.op, p, deps))
          continue
        } catch (e) {
          if (!(e instanceof PipelineError) || e.code !== 'no_arabic') throw e
        }
      }
      parts.push({
        text: p,
        warnings: [],
        applied: { proofread: 0, punctuation: 0 },
        tashkeelRan: false
      })
    }
    per = req.paragraphs.map((p, i) => diffText(p, parts[i].text))
    changed = per.some((l) => l.length > 0)
    const out = parts.map((x) => x.text)
    segments = changed ? previewSegments(req.paragraphs.join('\n'), out.join('\n')) : []
    const sum = (f: (x: PipelineResult) => number): number => parts.reduce((n, x) => n + f(x), 0)
    return {
      ok: true,
      changed,
      edits: per,
      segments,
      warnings: [...new Set(parts.flatMap((x) => x.warnings))].map((w) => WARNING_AR[w]),
      applied: {
        proofread: sum((x) => x.applied.proofread),
        punctuation: sum((x) => x.applied.punctuation)
      },
      tashkeelRan: parts.some((x) => x.tashkeelRan)
    }
  }
  // defence in depth: the edits must reproduce exactly the processed text
  const rebuilt = per.map((l, i) => applyEdits(req.paragraphs[i], l))
  const expected = rebuilt.join('\n')
  if (expected !== r.text) {
    const at = firstDiff(expected, r.text)
    throw new ProcessError(
      'unmappable',
      `تعذّر التحقق من نتيجة المعالجة. لم يُغيَّر النص. رمز: verify paras=${req.paragraphs.length} len=${joined.length} firstDiff=@${at} ${cp(expected[at])}/${cp(r.text[at])}`
    )
  }
  return {
    ok: true,
    changed,
    edits: per,
    segments,
    warnings: r.warnings.map((w) => WARNING_AR[w]),
    applied: r.applied,
    tashkeelRan: r.tashkeelRan
  }
}

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}
