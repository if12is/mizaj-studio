/* eslint-disable no-misleading-character-class -- combining marks are intentionally in ranges */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createZip, type ZipEntry } from './zip'
import { scrubSecrets } from './security'

/** Local, opt-in diagnostics (7.6.4 + 7.7.6). Nothing here touches the network. */

const AR = '\\u0600-\\u06FF\\u0750-\\u077F\\uFB50-\\uFDFF\\uFE70-\\uFEFF'
const ARABIC_RUN = new RegExp(`[${AR}][${AR}\\u0020\\u064B-\\u0652]{14,}`, 'g')
const ARABIC_ANY = new RegExp(`[${AR}]`, 'g')

/** Remove file paths, user names, e-mails and anything that could be document text. */
export function sanitizeLine(line: string, homes: string[] = []): string {
  // anyHex: a diagnostics bundle may lose sha256 values, but can never leak a 32-byte token
  let s = scrubSecrets(line, [], true)
  for (const h of homes) if (h && h.length > 2) s = s.split(h).join('~')
  s = s
    .replace(/[A-Za-z]:\\[^\s"'<>|]+/g, '<path>')
    .replace(/\\\\[^\s"'<>|\\]+\\[^\s"'<>|]+/g, '<path>')
    .replace(/(?:\/(?:home|Users|root|tmp|var|opt|mnt|media|private)\/[^\s"'<>:]+)/g, '<path>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(ARABIC_RUN, '[نص محجوب]')
    .replace(/"([^"\n]{81,})"/g, '"<long text removed>"')
  return s
}

export function sanitizeText(text: string, homes: string[] = []): string {
  return text
    .split(/\r?\n/)
    .map((l) => sanitizeLine(l, homes))
    .join('\n')
}

export function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

/** Only these settings go into a bundle: never per-document keys or user word lists. */
export const SETTINGS_WHITELIST = [
  'engine_mode',
  'tashkeel_level',
  'editor_font',
  'editor_font_size',
  'colored_diacritics',
  'diacritic_color',
  'theme',
  'high_contrast',
  'auto_update_check',
  'spell_check_enabled',
  'spell_cat_spelling',
  'spell_cat_pattern',
  'spell_cat_punctuation'
] as const

export function filterSettings(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of SETTINGS_WHITELIST) if (k in all) out[k] = all[k]
  return out
}

export interface VersionInfo {
  app: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  osRelease: string
  totalMemMB: number
  freeMemMB: number
  packaged: boolean
  portable: boolean
}

export interface CrashReport {
  time: string
  kind: string
  message: string
  stack: string
  versions: VersionInfo
  context?: Record<string, string | number | boolean | null>
}

export function buildCrashReport(
  kind: string,
  err: unknown,
  versions: VersionInfo,
  homes: string[],
  context?: CrashReport['context'],
  now = new Date()
): CrashReport {
  const e = err instanceof Error ? err : new Error(String(err))
  return {
    time: now.toISOString(),
    kind,
    message: sanitizeText(e.message ?? '', homes),
    stack: sanitizeText(e.stack ?? '', homes),
    versions,
    context
  }
}

export function writeCrashReport(dir: string, report: CrashReport): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `crash-${report.time.replace(/[:.]/g, '-')}-${report.kind}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
  return file
}

export interface BundleInput {
  userData: string
  versions: VersionInfo
  health: unknown
  settings: Record<string, string> | null
  homes: string[]
  logLines?: number
}

const README = `Mizaj Studio diagnostics bundle
===============================
Created locally on your request. Nothing was sent anywhere.
Contents: app/engine/OS versions, the engine /health report, a whitelist of app
settings, the last log lines (paths, e-mails and long Arabic text were removed) and
local crash reports. It contains NO document text, dictionary, glossary or file names.
Review it, then attach it to a GitHub issue yourself if you want to.
`

function readTail(file: string, n: number, homes: string[]): string | null {
  if (!existsSync(file)) return null
  return sanitizeText(tailLines(readFileSync(file, 'utf8'), n), homes)
}

export function buildBundleEntries(i: BundleInput): ZipEntry[] {
  const n = i.logLines ?? 2000
  const entries: ZipEntry[] = [
    { name: 'README.txt', data: README },
    { name: 'versions.json', data: JSON.stringify(i.versions, null, 2) },
    {
      name: 'health.json',
      data: scrubSecrets(
        JSON.stringify(i.health ?? { error: 'engine unavailable' }, null, 2),
        [],
        true
      )
    },
    {
      name: 'settings.json',
      data: JSON.stringify(i.settings ? filterSettings(i.settings) : {}, null, 2)
    }
  ]
  for (const f of ['mizaj-main.log', 'mizaj-backend.log']) {
    const t = readTail(join(i.userData, 'logs', f), n, i.homes)
    if (t !== null) entries.push({ name: `logs/${f}`, data: t })
  }
  const crashDir = join(i.userData, 'crash')
  if (existsSync(crashDir)) {
    for (const f of readdirSync(crashDir)
      .filter((x) => x.endsWith('.json'))
      .slice(-20)) {
      entries.push({
        name: `crash/${f}`,
        data: sanitizeText(readFileSync(join(crashDir, f), 'utf8'), i.homes)
      })
    }
  }
  return entries
}

export function buildBundle(i: BundleInput): Buffer {
  return createZip(buildBundleEntries(i))
}

/** True if the text still contains a run of Arabic that looks like prose (used by tests/guards). */
export function containsProse(text: string): boolean {
  return (text.match(ARABIC_ANY) ?? []).length > 0 && ARABIC_RUN.test(text)
}
