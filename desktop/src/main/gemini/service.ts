import {
  CONTINUE_PROMPT,
  generate,
  type Sleep,
  listModels,
  FALLBACK_MODELS,
  pickDefaultModel,
  isValidModelId,
  type FetchLike,
  type ModelInfo
} from './api'
import { askCli, detectCli, type CliDeps, type CliStatus } from './cli'
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
  type ParsedReply
} from './prompts'

export interface GeminiState {
  config: GeminiConfig
  hasKey: boolean
  /** masked hint only ("••••••••abcd"); the key itself never leaves the main process */
  keyHint: string | null
  encryptionAvailable: boolean
  cli: CliStatus
}

export type AskRequest =
  | { kind: 'document'; question: string; text: string; continueFrom?: string }
  | { kind: 'word'; question: string; word: string; sentence: string; continueFrom?: string }
  | {
      kind: 'selection'
      question: string
      text: string
      /** sentence containing the selection (context for word questions) */
      context?: string
      continueFrom?: string
    }

export interface AskResult extends ParsedReply {
  truncated: boolean
  /** the answer stopped at the output limit: offer «متابعة» */
  cutoff: boolean
  provider: 'api' | 'cli'
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
  cli: CliDeps
  /** test hook for the 500/503 backoff */
  sleep?: Sleep
}

export class GeminiService {
  private cliStatus: CliStatus = { detected: false, version: null, path: null }
  private cliChecked = false
  private limits = new Map<string, ModelInfo>()
  constructor(private readonly d: ServiceDeps) {}

  async getState(): Promise<GeminiState> {
    if (!this.cliChecked) await this.redetectCli()
    return this.snapshot()
  }

  private snapshot(): GeminiState {
    const key = this.d.keys.load()
    return {
      config: this.d.config.get(),
      hasKey: key !== null,
      keyHint: key ? maskKey(key) : null,
      encryptionAvailable: this.d.keys.encryptionAvailable(),
      cli: this.cliStatus
    }
  }

  private remember(models: ModelInfo[]): void {
    this.limits = new Map(models.map((m) => [m.id, m]))
  }

  async redetectCli(): Promise<CliStatus> {
    this.cliStatus = await detectCli(this.d.cli)
    this.cliChecked = true
    return this.cliStatus
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
      const info = cfg.provider === 'api' ? this.limits.get(model) : undefined
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
      let raw: string
      let cutoff = false
      if (cfg.provider === 'cli') {
        if (!cfg.useCli) throw new GeminiError('disabled')
        const cont = continueFrom
          ? `\n\nإجابتك السابقة (انقطعت):\n${continueFrom}\n\n${CONTINUE_PROMPT}`
          : ''
        raw = await askCli(`${system}\n\n${prompt}${cont}`, this.d.cli)
      } else {
        const key = this.d.keys.load()
        if (!key) throw new GeminiError('no_key')
        const g = await generate(this.d.fetch, this.d.base, key, model, system, prompt, {
          outputTokenLimit: info?.outputTokenLimit,
          continueFrom,
          sleep: this.d.sleep
        })
        raw = g.text
        cutoff = g.cutoff
      }
      return {
        ok: true,
        result: { ...parseReply(raw, req.kind), truncated, cutoff, provider: cfg.provider }
      }
    } catch (e) {
      return fail(e)
    }
  }
}
