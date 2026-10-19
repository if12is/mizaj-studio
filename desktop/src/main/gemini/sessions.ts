import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One stored chat message. User messages keep the short label shown in the panel. */
export interface ChatMessage {
  role: 'user' | 'model'
  text: string
  /** user messages: what the panel displays as the question, and its scope */
  q?: string
  scope?: 'doc' | 'selection'
}

export interface CacheRef {
  name: string
  model: string
  expiresAt: number
}

export interface ChatSession {
  docId: number
  /** hash of the document text the conversation is currently grounded on */
  hash: string
  history: ChatMessage[]
  cache: CacheRef | null
  updatedAt: number
}

export const MAX_HISTORY_MESSAGES = 40
export const MAX_HISTORY_CHARS = 120_000

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
}

export function isValidDocId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

function sanitize(raw: unknown, docId: number): ChatSession | null {
  const o = raw as Partial<ChatSession> | null
  if (!o || typeof o !== 'object' || o.docId !== docId || typeof o.hash !== 'string') return null
  const history: ChatMessage[] = []
  for (const m of Array.isArray(o.history) ? o.history : []) {
    if (!m || (m.role !== 'user' && m.role !== 'model') || typeof m.text !== 'string') continue
    history.push({
      role: m.role,
      text: m.text,
      ...(typeof m.q === 'string' ? { q: m.q } : {}),
      ...(m.scope === 'doc' || m.scope === 'selection' ? { scope: m.scope } : {})
    })
  }
  const c = o.cache
  const cache =
    c &&
    typeof c.name === 'string' &&
    typeof c.model === 'string' &&
    typeof c.expiresAt === 'number'
      ? { name: c.name, model: c.model, expiresAt: c.expiresAt }
      : null
  return {
    docId,
    hash: o.hash,
    history,
    cache,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0
  }
}

/** Drop the oldest messages (whole user/model pairs) until the history fits. */
export function trimHistory(h: ChatMessage[]): ChatMessage[] {
  let out = h
  const size = (): number => out.reduce((n, m) => n + m.text.length, 0)
  while (out.length > 2 && (out.length > MAX_HISTORY_MESSAGES || size() > MAX_HISTORY_CHARS)) {
    out = out.slice(out[1]?.role === 'model' ? 2 : 1)
  }
  return out
}

/**
 * Per-document chat sessions persisted in main-process userData (`<dir>/doc-<id>.json`).
 * The document text itself is never stored, only its hash plus the conversation.
 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  private file(docId: number): string {
    return join(this.dir, `doc-${docId}.json`)
  }

  get(docId: number): ChatSession | null {
    if (!isValidDocId(docId)) return null
    try {
      const f = this.file(docId)
      if (!existsSync(f)) return null
      return sanitize(JSON.parse(readFileSync(f, 'utf8')), docId)
    } catch {
      return null
    }
  }

  save(s: ChatSession): void {
    mkdirSync(this.dir, { recursive: true })
    const f = this.file(s.docId)
    const tmp = `${f}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...s, updatedAt: Date.now() }), { mode: 0o600 })
    renameSync(tmp, f)
  }

  /** «محادثة جديدة»: forgets the history (the caller deletes the remote cache). */
  clear(docId: number): void {
    if (!isValidDocId(docId)) return
    rmSync(this.file(docId), { force: true })
  }
}
