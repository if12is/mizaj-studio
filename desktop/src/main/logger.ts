import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { app } from 'electron'
import { scrubSecrets } from './security'

export const LOG_MAX_SIZE = 5 * 1024 * 1024
export const LOG_BACKUPS = 5

/** Shift file.log -> file.log.1 -> ... -> file.log.<keep>; the oldest is dropped. */
export function rotateLogFile(path: string, keep = LOG_BACKUPS): void {
  const oldest = `${path}.${keep}`
  if (existsSync(oldest)) rmSync(oldest, { force: true })
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${path}.${i}`
    if (existsSync(from)) renameSync(from, `${path}.${i + 1}`)
  }
  if (existsSync(path)) renameSync(path, `${path}.1`)
}

const secrets: string[] = []

/** Register a secret (the per-launch API token) so it can never reach a log file or the console. */
export function registerSecret(secret: string): void {
  if (secret && !secrets.includes(secret)) secrets.push(secret)
}

/** Scrub one log argument (strings, Errors, and nested plain objects/arrays). */
export function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return scrubSecrets(v, secrets)
  if (v instanceof Error) {
    const e = new Error(scrubSecrets(v.message, secrets))
    e.name = v.name
    e.stack = v.stack ? scrubSecrets(v.stack, secrets) : undefined
    return e
  }
  if (depth < 4 && Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1))
  if (depth < 4 && v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubValue(x, depth + 1)])
    )
  }
  return v
}

export function initLogger(): typeof log {
  log.hooks.push((message) => {
    message.data = message.data.map((d) => scrubValue(d))
    return message
  })
  log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'mizaj-main.log')
  log.transports.file.maxSize = LOG_MAX_SIZE
  log.transports.file.archiveLogFn = (oldLogFile) => {
    try {
      rotateLogFile(oldLogFile.path, LOG_BACKUPS)
    } catch (err) {
      console.error('log rotation failed', err)
    }
  }
  log.transports.file.level = 'debug'
  log.transports.console.level = 'debug'
  return log
}

export { log }
