import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Local-only hygiene for <userData> (8.2.4). Never touches documents, the database, models or packs. */

// Deliberately NOT .part/.partial: resumable downloads (8.4.2) keep those between launches.
const TEMP_FILE = /^(\.~mizaj_tmp.*|.*\.tmp)$/i
export const CRASH_KEEP = 50
export const CRASH_MAX_AGE_MS = 30 * 24 * 3600 * 1000

export interface CleanupResult {
  removed: string[]
}

/** Remove leftovers of interrupted writes: <userData>/tmp/*, top-level temp files, old crash reports. */
export function cleanupUserData(dir: string, now = Date.now()): CleanupResult {
  const removed: string[] = []
  const rm = (p: string): void => {
    try {
      rmSync(p, { recursive: true, force: true })
      removed.push(p)
    } catch {
      /* in use / permissions: harmless, try again next launch */
    }
  }
  if (!existsSync(dir)) return { removed }
  const tmp = join(dir, 'tmp')
  if (existsSync(tmp)) {
    for (const f of readdirSync(tmp)) rm(join(tmp, f))
  }
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    try {
      if (TEMP_FILE.test(f) && statSync(p).isFile()) rm(p)
    } catch {
      /* raced with another process */
    }
  }
  const crash = join(dir, 'crash')
  if (existsSync(crash)) {
    const files = readdirSync(crash)
      .filter((f) => f.endsWith('.json'))
      .sort()
    const excess = new Set(files.slice(0, Math.max(0, files.length - CRASH_KEEP)))
    for (const f of files) {
      const p = join(crash, f)
      let old = false
      try {
        old = now - statSync(p).mtimeMs > CRASH_MAX_AGE_MS
      } catch {
        /* ignore */
      }
      if (old || excess.has(f)) rm(p)
    }
  }
  return { removed }
}

/** POSIX only: userData and its log/crash folders readable by the owner alone. (Windows ACLs already scope %APPDATA%.) */
export function restrictPermissions(dir: string, platform = process.platform): void {
  if (platform === 'win32') return
  for (const d of [dir, join(dir, 'logs'), join(dir, 'crash')]) {
    try {
      mkdirSync(d, { recursive: true, mode: 0o700 })
      chmodSync(d, 0o700)
    } catch {
      /* best effort */
    }
  }
}
