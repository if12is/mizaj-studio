import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { app } from 'electron'

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

export function initLogger(): typeof log {
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
