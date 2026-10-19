import { app, BrowserWindow, dialog, session } from 'electron'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The user guide (docs/guide, built by `python docs/guide/build.py docs/guide/dist --offline`). */
export type GuidePage = 'quick' | 'guide'
const PAGES: readonly GuidePage[] = ['quick', 'guide']

export function guideDir(packaged = app.isPackaged): string {
  return packaged
    ? join(process.resourcesPath, 'guide')
    : join(app.getAppPath(), '..', 'docs', 'guide', 'dist')
}

/** Which guide page a URL points at, or null for anything else (links stay inside the guide). */
export function guidePageOf(url: string, dir: string): GuidePage | null {
  let file: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'file:') return null
    file = fileURLToPath(u)
  } catch {
    return null
  }
  const name = basename(file).replace(/\.html$/i, '') as GuidePage
  const same =
    process.platform === 'win32'
      ? resolve(dirname(file)).toLowerCase() === resolve(dir).toLowerCase()
      : resolve(dirname(file)) === resolve(dir)
  return same && PAGES.includes(name) ? name : null
}

let guideWin: BrowserWindow | null = null

/** Section anchors are the builder's slugs: Arabic/latin letters, digits, '-' and '_'. */
export function safeAnchor(a: unknown): string | undefined {
  return typeof a === 'string' && /^[\w\u0600-\u06FF-]{1,120}$/.test(a) ? a : undefined
}

/** Open (or focus) the guide in its own sandboxed window: no preload, no network, no permissions. */
export async function openGuide(
  page: GuidePage,
  parent: BrowserWindow | null,
  anchor?: string
): Promise<boolean> {
  const hash = safeAnchor(anchor)
  const dir = guideDir()
  const file = join(dir, `${page}.html`)
  if (!existsSync(file)) {
    const opts = {
      type: 'warning' as const,
      title: 'الدليل',
      message: 'الدليل غير متوفر في هذه النسخة.'
    }
    if (parent) await dialog.showMessageBox(parent, opts)
    else await dialog.showMessageBox(opts)
    return false
  }
  if (guideWin && !guideWin.isDestroyed()) {
    await guideWin.loadFile(file, { hash })
    guideWin.show()
    guideWin.focus()
    return true
  }
  const ses = session.fromPartition('guide')
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('file:') }))
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 400,
    title: 'دليل مِزَاج',
    autoHideMenuBar: true,
    backgroundColor: '#0B1220',
    webPreferences: {
      partition: 'guide',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      webviewTag: false
    }
  })
  guideWin = win
  win.on('closed', () => {
    if (guideWin === win) guideWin = null
  })
  // hardening.ts blocks every navigation away from the app; switching between the two guide
  // pages is reloaded here instead (anything else stays blocked).
  win.webContents.on('will-navigate', (_e, url) => {
    const target = guidePageOf(url, dir)
    if (target) setImmediate(() => void win.loadFile(join(dir, `${target}.html`)))
  })
  await win.loadFile(file, { hash })
  return true
}
