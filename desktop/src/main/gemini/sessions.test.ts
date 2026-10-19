import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hashText,
  isValidDocId,
  MAX_HISTORY_MESSAGES,
  SessionStore,
  trimHistory,
  type ChatMessage,
  type ChatSession
} from './sessions'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-sess-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const session = (over: Partial<ChatSession> = {}): ChatSession => ({
  docId: 7,
  hash: hashText('نص'),
  history: [
    { role: 'user', text: 'س', q: 'سؤال', scope: 'doc' },
    { role: 'model', text: 'ج' }
  ],
  cache: null,
  updatedAt: 0,
  ...over
})

describe('hashText / ids', () => {
  it('is stable and content-sensitive', () => {
    expect(hashText('أ')).toBe(hashText('أ'))
    expect(hashText('أ')).not.toBe(hashText('أَ'))
    expect(hashText('x')).toHaveLength(32)
  })
  it('accepts only positive integer ids', () => {
    expect(isValidDocId(3)).toBe(true)
    for (const bad of [0, -1, 1.5, '3', null, NaN]) expect(isValidDocId(bad)).toBe(false)
  })
})

describe('SessionStore', () => {
  it('persists per document and survives a new instance', () => {
    new SessionStore(dir).save(session())
    new SessionStore(dir).save(session({ docId: 8, hash: 'other' }))
    const again = new SessionStore(dir)
    expect(again.get(7)?.history).toHaveLength(2)
    expect(again.get(7)?.history[0]).toMatchObject({ q: 'سؤال', scope: 'doc' })
    expect(again.get(8)?.hash).toBe('other')
    expect(again.get(9)).toBeNull()
  })
  it('never stores the document text, only its hash', () => {
    const st = new SessionStore(dir)
    st.save(session())
    expect(readFileSync(join(dir, 'doc-7.json'), 'utf8')).not.toContain('"نص"')
  })
  it('clear() is the «محادثة جديدة» reset', () => {
    const st = new SessionStore(dir)
    st.save(session())
    st.clear(7)
    expect(st.get(7)).toBeNull()
    expect(() => st.clear(7)).not.toThrow()
  })
  it('treats corrupt or mismatched files as no session', () => {
    const st = new SessionStore(dir)
    writeFileSync(join(dir, 'doc-7.json'), '{not json')
    expect(st.get(7)).toBeNull()
    writeFileSync(join(dir, 'doc-7.json'), JSON.stringify(session({ docId: 99 })))
    expect(st.get(7)).toBeNull()
  })
  it('drops malformed messages when loading and rejects bad ids', () => {
    const st = new SessionStore(dir)
    writeFileSync(
      join(dir, 'doc-7.json'),
      JSON.stringify({
        ...session(),
        history: [{ role: 'system', text: 'x' }, { role: 'user' }, { role: 'user', text: 'ok' }]
      })
    )
    expect(st.get(7)?.history).toEqual([{ role: 'user', text: 'ok' }])
    expect(st.get(-1)).toBeNull()
    expect(() => st.clear(0)).not.toThrow()
  })
  it('keeps the cache reference', () => {
    const st = new SessionStore(dir)
    st.save(session({ cache: { name: 'cachedContents/abc', model: 'm', expiresAt: 5 } }))
    expect(st.get(7)?.cache).toEqual({ name: 'cachedContents/abc', model: 'm', expiresAt: 5 })
  })
})

describe('trimHistory', () => {
  it('drops the oldest whole pairs past the limit', () => {
    const h: ChatMessage[] = []
    for (let i = 0; i < MAX_HISTORY_MESSAGES; i++)
      h.push({ role: 'user', text: `q${i}` }, { role: 'model', text: `a${i}` })
    const t = trimHistory(h)
    expect(t.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES)
    expect(t[0].role).toBe('user')
    expect(t.at(-1)).toEqual({ role: 'model', text: `a${MAX_HISTORY_MESSAGES - 1}` })
  })
})
