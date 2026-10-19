import {
  CONTINUE_PROMPT,
  generate,
  generateChat,
  modelContent,
  userContent,
  type Content,
  type Sleep,
  listModels,
  FALLBACK_MODELS,
  pickDefaultModel,
  isValidModelId,
  type FetchLike,
  type ModelInfo
} from './api'
import { GeminiConfigStore, type GeminiConfig } from './config'
import { GeminiError, messageFor } from './errors'
import { GeminiKeyStore, isPlausibleKey, maskKey } from './keyStore'
import {
  buildDocumentPrompt,
  buildWordPrompt,
  buildSelectionPrompt,
  docLimit,
  systemPromptFor,
  MAX_SELECTION_CHARS,
  parseReply,
  MAX_DOC_CHARS,
  MAX_QUESTION_CHARS,
  MAX_SENTENCE_CHARS,
  buildDocumentTurn,
  buildSessionQuestion,
  DOC_ACK,
  SESSION_SYSTEM,
  type ParsedReply
} from './prompts'
import { CacheSupport, deleteRemoteCache, ensureCache, isCacheGone } from './cache'
import {
  hashText,
  isValidDocId,
  trimHistory,
  type ChatSession,
  type SessionStore
} from './sessions'

export interface GeminiState {
  config: GeminiConfig
  hasKey: boolean
  /** masked hint only ("••••••••abcd"); the key itself never leaves the main process */
  keyHint: string | null
  encryptionAvailable: boolean
}

export type AskRequest =
  | {
      kind: 'document'
      question: string
      text: string
      /** open document: enables the per-document chat session */
      docId?: number
      continueFrom?: string
    }
  | { kind: 'word'; question: string; word: string; sentence: string; continueFrom?: string }
  | {
      kind: 'selection'
      question: string
      text: string
      /** sentence containing the selection (context for word questions) */
      context?: string
      /** open document + its full text: the question joins that document's chat session */
      docId?: number
      docText?: string
      continueFrom?: string
    }

export interface AskResult extends ParsedReply {
  truncated: boolean
  /** the answer stopped at the output limit: offer «متابعة» */
  cutoff: boolean
  /** the document context was re-sent because its text changed since the last question */
  contextRefreshed: boolean
  /** how the document prefix was served: explicit cache, plain (implicit caching), or no session */
  context: 'explicit' | 'inline' | 'none'
}

export interface SessionMessageDto {
  q: string
  scope: 'doc' | 'selection'
  answer: string
}

export interface SessionInfo {
  messages: SessionMessageDto[]
  /** a conversation exists but was grounded on different document text */
  stale: boolean
}

export type Outcome<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string; retryAfterSec?: number }

function fail(e: unknown): {
  ok: false
  code: string
  message: string
  retryAfterSec?: number
} {
  if (e instanceof GeminiError)
    return {
      ok: false,
      code: e.code,
      message: e.message,
      ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {})
    }
  return { ok: false, code: 'bad_response', message: messageFor('bad_response') }
}

export interface ServiceDeps {
  keys: GeminiKeyStore
  config: GeminiConfigStore
  fetch: FetchLike
  base: string
  sessions: SessionStore
  /** test hook for the 500/503 backoff */
  sleep?: Sleep
}

export class GeminiService {
  private cacheSupport = new CacheSupport()
  private limits = new Map<string, ModelInfo>()
  constructor(private readonly d: ServiceDeps) {}

  async getState(): Promise<GeminiState> {
    return this.snapshot()
  }

  private snapshot(): GeminiState {
    const key = this.d.keys.load()
    return {
      config: this.d.config.get(),
      hasKey: key !== null,
      keyHint: key ? maskKey(key) : null,
      encryptionAvailable: this.d.keys.encryptionAvailable()
    }
  }

  private remember(models: ModelInfo[]): void {
    this.limits = new Map(models.map((m) => [m.id, m]))
  }

  setConfig(patch: unknown): GeminiState {
    this.d.config.update(patch)
    return this.snapshot()
  }

  acceptConsent(): GeminiState {
    this.d.config.acceptConsent()
    return this.snapshot()
  }

  saveKey(key: unknown): Outcome<{ state: GeminiState }> {
    const k = typeof key === 'string' ? key.trim() : ''
    if (!isPlausibleKey(k))
      return { ok: false, code: 'invalid_key', message: messageFor('invalid_key') }
    const r = this.d.keys.save(k)
    if (!r.ok)
      return {
        ok: false,
        code: r.reason === 'unavailable' ? 'unavailable' : 'invalid_key',
        message: messageFor(r.reason === 'unavailable' ? 'unavailable' : 'invalid_key')
      }
    return { ok: true, state: this.snapshot() }
  }

  clearKey(): GeminiState {
    this.d.keys.clear()
    return this.snapshot()
  }

  /** Validates a key (typed candidate or the stored one) by listing models. */
  async testKey(
    candidate?: unknown
  ): Promise<Outcome<{ models: ModelInfo[]; defaultModel: string }>> {
    const key =
      typeof candidate === 'string' && candidate.trim() ? candidate.trim() : this.d.keys.load()
    if (!key) return fail(new GeminiError('no_key'))
    if (!isPlausibleKey(key)) return fail(new GeminiError('invalid_key'))
    try {
      const models = await listModels(this.d.fetch, this.d.base, key)
      this.remember(models)
      return { ok: true, models, defaultModel: pickDefaultModel(models) }
    } catch (e) {
      return fail(e)
    }
  }

  /** Live model list with the stored key; offline fallback only when Google is unreachable. */
  async models(): Promise<
    Outcome<{ models: ModelInfo[]; defaultModel: string; source: 'live' | 'fallback' }>
  > {
    const key = this.d.keys.load()
    if (!key) return fail(new GeminiError('no_key'))
    try {
      const models = await listModels(this.d.fetch, this.d.base, key)
      this.remember(models)
      return { ok: true, models, defaultModel: pickDefaultModel(models), source: 'live' }
    } catch (e) {
      if (e instanceof GeminiError && (e.code === 'offline' || e.code === 'timeout')) {
        const models = FALLBACK_MODELS.map((id) => ({ id, display: id }))
        return { ok: true, models, defaultModel: pickDefaultModel(models), source: 'fallback' }
      }
      return fail(e)
    }
  }

  async ask(req: AskRequest): Promise<Outcome<{ result: AskResult }>> {
    try {
      const cfg = this.d.config.get()
      if (!cfg.enabled) throw new GeminiError('disabled')
      if (!cfg.consentAt) throw new GeminiError('consent')
      const q = (req as { question?: unknown }).question
      if (typeof q !== 'string' || !q.trim() || q.length > MAX_QUESTION_CHARS)
        throw new GeminiError('bad_request')
      const cf = (req as { continueFrom?: unknown }).continueFrom
      if (cf !== undefined && (typeof cf !== 'string' || cf.length > 200_000))
        throw new GeminiError('bad_request')
      const continueFrom = typeof cf === 'string' && cf ? cf : undefined
      const model = isValidModelId(cfg.model) ? cfg.model : FALLBACK_MODELS[0]
      const info = this.limits.get(model)
      const docId = (req as { docId?: unknown }).docId
      if (docId !== undefined && req.kind !== 'word') {
        if (!isValidDocId(docId)) throw new GeminiError('bad_request')
        return await this.askInSession(req, docId, q, model, info, continueFrom)
      }
      let prompt: string
      let truncated = false
      if (req.kind === 'document') {
        if (typeof req.text !== 'string' || !req.text.trim() || req.text.length > MAX_DOC_CHARS * 5)
          throw new GeminiError('bad_request')
        const b = buildDocumentPrompt(q, req.text, docLimit(info?.inputTokenLimit))
        prompt = b.text
        truncated = b.truncated
      } else if (req.kind === 'word') {
        if (
          typeof req.word !== 'string' ||
          typeof req.sentence !== 'string' ||
          !req.word.trim() ||
          req.sentence.length > MAX_SENTENCE_CHARS
        )
          throw new GeminiError('bad_request')
        prompt = buildWordPrompt(q, req.word, req.sentence)
      } else if (req.kind === 'selection') {
        if (
          typeof req.text !== 'string' ||
          !req.text.trim() ||
          req.text.length > MAX_SELECTION_CHARS
        )
          throw new GeminiError('bad_request')
        const ctx = (req as { context?: unknown }).context
        prompt = buildSelectionPrompt(
          q,
          req.text,
          typeof ctx === 'string' ? ctx.slice(0, MAX_SENTENCE_CHARS) : undefined
        )
      } else throw new GeminiError('bad_request')

      const system = systemPromptFor(req.kind)
      const key = this.d.keys.load()
      if (!key) throw new GeminiError('no_key')
      const g = await generate(this.d.fetch, this.d.base, key, model, system, prompt, {
        outputTokenLimit: info?.outputTokenLimit,
        continueFrom,
        sleep: this.d.sleep
      })
      return {
        ok: true,
        result: {
          ...parseReply(g.text, req.kind),
          truncated,
          cutoff: g.cutoff,
          contextRefreshed: false,
          context: 'none'
        }
      }
    } catch (e) {
      return fail(e)
    }
  }

  /** Existing conversation for a document (for the panel), without calling Google. */
  getSession(docId: unknown, text?: unknown): Outcome<{ session: SessionInfo }> {
    if (!isValidDocId(docId)) return fail(new GeminiError('bad_request'))
    const s = this.d.sessions.get(docId)
    const messages: SessionMessageDto[] = []
    for (let i = 0; s && i + 1 < s.history.length; i += 2) {
      const u = s.history[i]
      const m = s.history[i + 1]
      if (u.role === 'user' && m.role === 'model')
        messages.push({ q: u.q ?? '', scope: u.scope ?? 'doc', answer: m.text })
    }
    const stale = !!s && typeof text === 'string' && !!text && hashText(text) !== s.hash
    return { ok: true, session: { messages, stale } }
  }

  /** «محادثة جديدة»: forget the history and the remote cache of this document. */
  async resetSession(docId: unknown): Promise<Outcome<object>> {
    if (!isValidDocId(docId)) return fail(new GeminiError('bad_request'))
    const s = this.d.sessions.get(docId)
    const key = this.d.keys.load()
    if (s?.cache && key) await deleteRemoteCache(this.d.fetch, this.d.base, key, s.cache.name)
    this.d.sessions.clear(docId)
    return { ok: true }
  }

  private async askInSession(
    req: Extract<AskRequest, { kind: 'document' | 'selection' }>,
    docId: number,
    q: string,
    model: string,
    info: ModelInfo | undefined,
    continueFrom: string | undefined
  ): Promise<Outcome<{ result: AskResult }>> {
    const docText = req.kind === 'document' ? req.text : (req as { docText?: unknown }).docText
    if (typeof docText !== 'string' || !docText.trim() || docText.length > MAX_DOC_CHARS * 5)
      throw new GeminiError('bad_request')
    let sel: string | undefined
    let sentence: string | undefined
    if (req.kind === 'selection') {
      if (typeof req.text !== 'string' || !req.text.trim() || req.text.length > MAX_SELECTION_CHARS)
        throw new GeminiError('bad_request')
      sel = req.text
      const ctx = (req as { context?: unknown }).context
      sentence = typeof ctx === 'string' ? ctx.slice(0, MAX_SENTENCE_CHARS) : undefined
    }
    const key = this.d.keys.load()
    if (!key) throw new GeminiError('no_key')

    const doc = buildDocumentTurn(docText, docLimit(info?.inputTokenLimit))
    const hash = hashText(docText)
    const stored = this.d.sessions.get(docId)
    const session: ChatSession = stored ?? { docId, hash, history: [], cache: null, updatedAt: 0 }
    let contextRefreshed = false
    if (stored && stored.hash !== hash) {
      // the document changed: re-ground the conversation on the new text, drop the old cache
      contextRefreshed = true
      if (stored.cache) await deleteRemoteCache(this.d.fetch, this.d.base, key, stored.cache.name)
      session.hash = hash
      session.cache = null
    }

    const prefix: Content[] = [userContent(doc.text), modelContent(DOC_ACK)]
    const hist: Content[] = session.history.map((m) =>
      m.role === 'user' ? userContent(m.text) : modelContent(m.text)
    )
    let userText: string
    if (continueFrom) {
      if (session.history.at(-1)?.role !== 'model') throw new GeminiError('bad_request')
      userText = CONTINUE_PROMPT
    } else userText = buildSessionQuestion(req.kind, q, sel, sentence)
    const turn: Content[] = [...hist, userContent(userText)]
    const opts = { outputTokenLimit: info?.outputTokenLimit, sleep: this.d.sleep }

    const cacheArgs = {
      f: this.d.fetch,
      base: this.d.base,
      key,
      model,
      system: SESSION_SYSTEM,
      prefix,
      docChars: docText.length,
      session,
      support: this.cacheSupport
    }
    let g: Awaited<ReturnType<typeof generateChat>> | null = null
    let context: 'explicit' | 'inline' = 'inline'
    let cacheName = await ensureCache(cacheArgs)
    for (let attempt = 0; cacheName && attempt < 2 && !g; attempt++) {
      try {
        g = await generateChat(
          this.d.fetch,
          this.d.base,
          key,
          model,
          { cachedContent: cacheName, contents: turn },
          opts
        )
        context = 'explicit'
      } catch (e) {
        if (!isCacheGone(e)) throw e
        // expired or deleted server side: recreate once, then fall back to inline
        cacheName = attempt === 0 ? await ensureCache({ ...cacheArgs, force: true }) : null
      }
    }
    if (!g) {
      session.cache = null
      g = await generateChat(
        this.d.fetch,
        this.d.base,
        key,
        model,
        { system: SESSION_SYSTEM, contents: [...prefix, ...turn] },
        opts
      )
    }

    if (continueFrom) {
      const last = session.history[session.history.length - 1]
      last.text = `${last.text}${/\s$/.test(last.text) ? '' : ' '}${g.text}`
    } else {
      session.history.push(
        { role: 'user', text: userText, q, scope: req.kind === 'document' ? 'doc' : 'selection' },
        { role: 'model', text: g.text }
      )
    }
    session.history = trimHistory(session.history)
    try {
      this.d.sessions.save(session)
    } catch {
      /* persistence is best effort; the answer is still returned */
    }
    return {
      ok: true,
      result: {
        ...parseReply(g.text, req.kind),
        truncated: doc.truncated,
        cutoff: g.cutoff,
        contextRefreshed,
        context
      }
    }
  }
}
