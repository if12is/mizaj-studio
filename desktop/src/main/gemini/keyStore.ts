import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/** The subset of Electron's safeStorage used here (injectable so tests need no Electron). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(enc: Buffer): string
}

export type KeyStoreResult = { ok: true } | { ok: false; reason: 'unavailable' | 'invalid' }

/** Google AI Studio keys look like `AIza...` (39 chars); be lenient but reject junk. */
export function isPlausibleKey(k: unknown): k is string {
  return typeof k === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(k)
}

/** Masked hint safe to show in the UI: never more than the last 4 characters. */
export function maskKey(k: string): string {
  return k.length >= 8 ? `••••••••${k.slice(-4)}` : '••••••••'
}

/**
 * Stores the API key ENCRYPTED with the OS keychain (safeStorage) in one file under userData.
 * Without encryption support nothing is written: the key is never stored in plain text.
 */
export class GeminiKeyStore {
  constructor(
    private readonly file: string,
    private readonly storage: SafeStorageLike
  ) {}

  encryptionAvailable(): boolean {
    try {
      return this.storage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  save(key: string): KeyStoreResult {
    const k = typeof key === 'string' ? key.trim() : ''
    if (!isPlausibleKey(k)) return { ok: false, reason: 'invalid' }
    if (!this.encryptionAvailable()) return { ok: false, reason: 'unavailable' }
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, this.storage.encryptString(k), { mode: 0o600 })
    renameSync(tmp, this.file)
    return { ok: true }
  }

  /** Decrypted key for use in the main process only; null when absent/undecryptable. */
  load(): string | null {
    if (!existsSync(this.file) || !this.encryptionAvailable()) return null
    try {
      const k = this.storage.decryptString(readFileSync(this.file))
      return isPlausibleKey(k) ? k : null
    } catch {
      return null
    }
  }

  has(): boolean {
    return this.load() !== null
  }

  hint(): string | null {
    const k = this.load()
    return k ? maskKey(k) : null
  }

  clear(): void {
    rmSync(this.file, { force: true })
  }
}
