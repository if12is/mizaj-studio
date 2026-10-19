/**
 * Fills desktop/word-addin/manifest.template.xml. Pure: the template text is passed in, so the
 * generator is tested without the file system and without Electron.
 */

export const ADDIN_VERSION = '1.0.0.0'
/** Fixed HTTPS port of the add-in host (manifest URLs cannot follow a random port). */
export const ADDIN_PORT = 47615

export interface ManifestParams {
  /** add-in GUID, fresh per install */
  id: string
  port: number
  /** per-install pairing token (URL-safe) */
  token: string
  version?: string
}

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export function addinOrigin(port: number): string {
  return `https://localhost:${port}`
}

export function pageUrl(page: 'taskpane' | 'commands', port: number, token: string): string {
  return `${addinOrigin(port)}/${page}.html?k=${token}`
}

export function buildManifest(template: string, p: ManifestParams): string {
  if (!GUID_RE.test(p.id)) throw new Error('bad add-in id')
  if (!TOKEN_RE.test(p.token)) throw new Error('bad pairing token')
  if (!Number.isInteger(p.port) || p.port < 1024 || p.port > 65535) throw new Error('bad port')
  const values: Record<string, string> = {
    ID: p.id.toLowerCase(),
    VERSION: p.version ?? ADDIN_VERSION,
    ORIGIN: addinOrigin(p.port),
    TASKPANE_URL: pageUrl('taskpane', p.port, p.token),
    COMMANDS_URL: pageUrl('commands', p.port, p.token)
  }
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, k: string) => {
    if (!(k in values)) throw new Error(`unknown placeholder ${k}`)
    return xmlEscape(values[k])
  })
  if (/\{\{|\}\}/.test(out)) throw new Error('unfilled placeholder')
  return out
}

export interface ManifestFacts {
  id: string | null
  port: number | null
  token: string | null
}

/** Reads back the Id / port / token of an installed manifest (for the "verify" step). */
export function readManifestFacts(xml: string): ManifestFacts {
  const id = /<Id>([^<]+)<\/Id>/.exec(xml)?.[1] ?? null
  const src =
    /<SourceLocation DefaultValue="https:\/\/localhost:(\d+)\/taskpane\.html\?k=([^"]+)"/.exec(xml)
  return { id, port: src ? Number(src[1]) : null, token: src ? src[2] : null }
}

export interface ManifestProblem {
  rule: string
  detail: string
}

/**
 * Structural validation against the rules of the Office add-in manifest schema that matter here
 * (element order of the root, https-only URLs, resid cross-references, label length limits).
 * The official `office-addin-manifest validate` and the XSDs need network access or are not
 * bundled, so this is the offline check the unit tests run (see manifest.test.ts).
 */
export function validateManifestStructure(xml: string): ManifestProblem[] {
  const problems: ManifestProblem[] = []
  const bad = (rule: string, detail: string): void => {
    problems.push({ rule, detail })
  }
  if (!/^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(xml.trimStart()))
    bad('xml-decl', 'missing')
  // root order (OfficeApp children), top-level only: strip the VersionOverrides block first
  const top = xml.replace(/<VersionOverrides[\s\S]*<\/VersionOverrides>/, '<VersionOverrides/>')
  const order = [
    'Id',
    'Version',
    'ProviderName',
    'DefaultLocale',
    'DisplayName',
    'Description',
    'IconUrl',
    'HighResolutionIconUrl',
    'SupportUrl',
    'AppDomains',
    'Hosts',
    'DefaultSettings',
    'Permissions',
    'VersionOverrides'
  ]
  const body = top.replace(/<!--[\s\S]*?-->/g, '')
  const found = [...body.matchAll(/^ {2}<([A-Za-z]+)[ >/]/gm)].map((m) => m[1])
  const idx = found.map((n) => order.indexOf(n))
  if (idx.includes(-1)) bad('root-children', `unexpected child in ${found.join(',')}`)
  else if (idx.some((v, i) => i > 0 && v < idx[i - 1])) bad('root-order', found.join(','))
  for (const n of order) if (!found.includes(n)) bad('root-missing', n)

  if (!GUID_RE.test(/<Id>([^<]*)<\/Id>/.exec(xml)?.[1] ?? '')) bad('id', 'not a GUID')
  if (!/<Version>\d+\.\d+\.\d+\.\d+<\/Version>/.test(xml)) bad('version', 'not 4-part')
  if (!/<Host Name="Document"\/>/.test(xml)) bad('host', 'Document host missing (Word)')
  if (!/<Permissions>ReadWriteDocument<\/Permissions>/.test(xml)) bad('permissions', 'unexpected')

  // every URL must be https://localhost:<port> (Office requires HTTPS)
  const urls = [
    ...xml
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/xmlns(:\w+)?="[^"]*"/g, '')
      .matchAll(/https?:\/\/[^"<\s]+/g)
  ].map((m) => m[0])
  for (const u of urls) if (!/^https:\/\/localhost:\d+(\/|$)/.test(u)) bad('https-url', u)
  if (xml.includes('http://localhost')) bad('https-url', 'plain http URL')

  // resid cross references
  const defined = new Set(
    [...xml.matchAll(/<bt:(?:Image|Url|String) id="([^"]+)"/g)].map((m) => m[1])
  )
  for (const m of xml.matchAll(/resid="([^"]+)"/g))
    if (!defined.has(m[1])) bad('resid', `undefined resid ${m[1]}`)
  // limits: ShortStrings <= 125, Label-ish <= 32 (tab/group/button labels are short strings), LongStrings <= 250
  for (const m of xml.matchAll(/<bt:ShortStrings>([\s\S]*?)<\/bt:ShortStrings>/g))
    for (const s of m[1].matchAll(/DefaultValue="([^"]*)"/g))
      if ([...s[1]].length > 32) bad('label-length', s[1])
  for (const m of xml.matchAll(/<bt:LongStrings>([\s\S]*?)<\/bt:LongStrings>/g))
    for (const s of m[1].matchAll(/DefaultValue="([^"]*)"/g))
      if ([...s[1]].length > 250) bad('tip-length', s[1].slice(0, 20))

  // ExecuteFunction names must be unique and match the function-file registrations
  const fns = [...xml.matchAll(/<FunctionName>([^<]+)<\/FunctionName>/g)].map((m) => m[1])
  if (new Set(fns).size !== fns.length) bad('function-names', 'duplicate')
  const ids = [...xml.matchAll(/<(?:Control|Group|CustomTab)[^>]* id="([^"]+)"/g)].map((m) => m[1])
  if (new Set(ids).size !== ids.length) bad('ids', 'duplicate control/group/tab id')
  return problems
}

/** The function names the manifest binds to the four ribbon buttons (commands.ts registers them). */
export const COMMAND_FUNCTIONS = {
  proofread: 'mizajProofread',
  punctuation: 'mizajPunctuation',
  tashkeel: 'mizajTashkeel',
  all: 'mizajAll'
} as const
