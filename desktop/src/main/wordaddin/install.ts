/**
 * Windows-side installation primitives of the Word add-in, over an injected `exec`
 * (reg.exe / certutil.exe). Pure of Electron and of the file system, so it is unit-tested with a
 * fake exec. None of the arguments ever contains document text.
 *
 * SIDELOAD METHOD (chosen): the developer registry key used by Microsoft's own tooling
 * (office-addin-dev-settings):
 *     HKCU\Software\Microsoft\Office\16.0\WEF\Developer
 *     value name = the manifest <Id> GUID, REG_SZ data = full path of manifest.xml
 * No share, no admin rights, no Trust Center clicks. The add-in then appears under
 * Insert > Add-ins > My Add-ins > "Developer Add-ins" and its ribbon tab loads after Word restarts.
 * FALLBACK (manual, documented in the guide): a "Trusted Add-in Catalog" on a network share (UNC).
 * Both depend on Word's behaviour, which cannot be verified on the build machine (Linux).
 *
 * CERTIFICATE: certutil -user -addstore Root <file>. CurrentUser store, no admin; Windows itself
 * shows its security confirmation. Removal by thumbprint.
 */

export interface ExecResult {
  code: number
  stdout: string
}
export type Exec = (file: string, args: string[]) => Promise<ExecResult>

export const REG_KEY = 'HKCU\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer'
const WEBVIEW2_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
]

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const THUMB = /^[0-9A-Fa-f]{40}$/

export async function registerAddin(
  exec: Exec,
  id: string,
  manifestPath: string
): Promise<boolean> {
  if (!GUID.test(id)) throw new Error('bad id')
  const r = await exec('reg.exe', [
    'add',
    REG_KEY,
    '/v',
    id,
    '/t',
    'REG_SZ',
    '/d',
    manifestPath,
    '/f'
  ])
  return r.code === 0
}

export async function unregisterAddin(exec: Exec, id: string): Promise<boolean> {
  if (!GUID.test(id)) throw new Error('bad id')
  const r = await exec('reg.exe', ['delete', REG_KEY, '/v', id, '/f'])
  // 1 = value not found: already absent is success
  return r.code === 0 || r.code === 1
}

/** The manifest path registered for `id`, or null. Parses `reg query` output (locale independent). */
export async function queryRegistration(exec: Exec, id: string): Promise<string | null> {
  if (!GUID.test(id)) return null
  const r = await exec('reg.exe', ['query', REG_KEY, '/v', id])
  if (r.code !== 0) return null
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_SZ\s+(.+?)\s*$/.exec(line)
    if (m && m[1].toLowerCase() === id.toLowerCase()) return m[2]
  }
  return null
}

export async function trustCert(exec: Exec, certPath: string): Promise<boolean> {
  const r = await exec('certutil.exe', ['-user', '-addstore', 'Root', certPath])
  return r.code === 0
}

export async function untrustCert(exec: Exec, thumbprint: string): Promise<boolean> {
  if (!THUMB.test(thumbprint)) throw new Error('bad thumbprint')
  const r = await exec('certutil.exe', ['-user', '-delstore', 'Root', thumbprint])
  // already absent (CRYPT_E_NOT_FOUND) is fine for an uninstall
  return r.code === 0 || (await isCertTrusted(exec, thumbprint)) === false
}

export async function isCertTrusted(exec: Exec, thumbprint: string): Promise<boolean> {
  if (!THUMB.test(thumbprint)) return false
  const r = await exec('certutil.exe', ['-user', '-store', 'Root', thumbprint])
  return r.code === 0
}

/** Word installed (Click-to-Run or MSI, per-user registration) and WebView2 runtime present. */
export async function detectEnvironment(exec: Exec): Promise<{ word: boolean; webview2: boolean }> {
  const word =
    (await exec('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Office\\16.0\\Word'])).code === 0
  let webview2 = false
  for (const k of WEBVIEW2_KEYS)
    if ((await exec('reg.exe', ['query', k, '/v', 'pv'])).code === 0) webview2 = true
  return { word, webview2 }
}

export type CheckLevel = 'ok' | 'warn' | 'fail'
export interface Check {
  id:
    | 'server'
    | 'cert-file'
    | 'cert-trust'
    | 'registry'
    | 'manifest'
    | 'pairing'
    | 'word'
    | 'webview2'
  level: CheckLevel
  /** Arabic, shown to the user */
  text: string
}

export interface CheckInput {
  serverListening: boolean
  certExists: boolean
  certExpired: boolean
  certNeedsRenewal: boolean
  certTrusted: boolean | null
  registeredPath: string | null
  expectedManifestPath: string
  manifestExists: boolean
  manifestMatches: boolean
  paired: boolean
  word: boolean | null
  webview2: boolean | null
}

/** Turns raw facts into the «تحقق» checklist. Pure. */
export function buildChecks(i: CheckInput): Check[] {
  const c: Check[] = []
  c.push(
    i.serverListening
      ? { id: 'server', level: 'ok', text: 'خادم الإضافة يعمل على https://localhost.' }
      : {
          id: 'server',
          level: 'fail',
          text: 'خادم الإضافة متوقف. فعّل الميزة وأبقِ مِزَاج مفتوحاً.'
        }
  )
  if (!i.certExists) c.push({ id: 'cert-file', level: 'fail', text: 'لم تُنشأ شهادة الإضافة بعد.' })
  else if (i.certExpired)
    c.push({
      id: 'cert-file',
      level: 'fail',
      text: 'انتهت صلاحية الشهادة. أعد التثبيت لإنشاء شهادة جديدة.'
    })
  else if (i.certNeedsRenewal)
    c.push({
      id: 'cert-file',
      level: 'warn',
      text: 'ستنتهي صلاحية الشهادة قريباً. أعد التثبيت لتجديدها.'
    })
  else c.push({ id: 'cert-file', level: 'ok', text: 'شهادة الإضافة سليمة.' })
  c.push(
    i.certTrusted === null
      ? { id: 'cert-trust', level: 'warn', text: 'تعذّر فحص الثقة بالشهادة.' }
      : i.certTrusted
        ? { id: 'cert-trust', level: 'ok', text: 'ويندوز يثق بالشهادة (مخزن المستخدم الحالي).' }
        : {
            id: 'cert-trust',
            level: 'fail',
            text: 'ويندوز لا يثق بالشهادة بعد: بدونها لن يفتح Word صفحات الإضافة. اضغط «تثبيت» ووافق على نافذة ويندوز.'
          }
  )
  if (!i.registeredPath)
    c.push({ id: 'registry', level: 'fail', text: 'الإضافة غير مسجَّلة في Word (مفتاح المطوّر).' })
  else if (i.registeredPath.toLowerCase() !== i.expectedManifestPath.toLowerCase())
    c.push({
      id: 'registry',
      level: 'fail',
      text: 'مفتاح Word يشير إلى ملف manifest آخر. أعد التثبيت.'
    })
  else c.push({ id: 'registry', level: 'ok', text: 'الإضافة مسجَّلة في Word.' })
  if (!i.manifestExists)
    c.push({ id: 'manifest', level: 'fail', text: 'ملف manifest.xml غير موجود.' })
  else if (!i.manifestMatches)
    c.push({
      id: 'manifest',
      level: 'fail',
      text: 'ملف manifest.xml لا يطابق الإعدادات الحالية. أعد التثبيت.'
    })
  else c.push({ id: 'manifest', level: 'ok', text: 'ملف manifest.xml سليم.' })
  c.push(
    i.paired
      ? { id: 'pairing', level: 'ok', text: 'رمز الاقتران مُنشأ.' }
      : { id: 'pairing', level: 'fail', text: 'لا يوجد رمز اقتران: الإضافة غير مثبّتة.' }
  )
  if (i.word !== null)
    c.push(
      i.word
        ? { id: 'word', level: 'ok', text: 'تم العثور على Microsoft Word (الإصدار 16).' }
        : {
            id: 'word',
            level: 'warn',
            text: 'لم يُعثر على Microsoft Word 2016 أو أحدث لهذا المستخدم.'
          }
    )
  if (i.webview2 !== null)
    c.push(
      i.webview2
        ? { id: 'webview2', level: 'ok', text: 'WebView2 مثبّت.' }
        : {
            id: 'webview2',
            level: 'warn',
            text: 'لم يُعثر على WebView2. الإضافات الحديثة تحتاجه (يأتي مع Microsoft 365 وويندوز 11).'
          }
    )
  return c
}

export const checksPassed = (c: readonly Check[]): boolean => c.every((x) => x.level !== 'fail')
