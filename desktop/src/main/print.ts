import { BrowserWindow } from 'electron'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dialogPaths } from './fileIpc'
import { isBoundedString, MAX_PATH_LENGTH } from './security'

/**
 * Printing (Ctrl+P) and «حفظ PDF». The renderer paginates the document into fixed-size sheets
 * (src/renderer/src/print/sheets.ts: header, Arabic-Indic page numbers, RTL) and sends their HTML
 * here. A hidden, sandboxed window (print.html: no preload, no network) shows exactly those
 * sheets; `webContents.print` opens the system print dialog, `printToPDF` writes the file.
 */
export interface PrintRequest {
  html: string
  widthPt: number
  heightPt: number
  pages: number
  mode: 'print' | 'pdf'
  /** pdf only: a path returned by a native save dialog */
  targetPath?: string
}
export type PrintResult = { ok: true; pages: number } | { ok: false; error: string }

const MAX_HTML = 96 * 1024 * 1024
const MICRONS_PER_PT = 352.778

export function parsePrintRequest(raw: unknown): PrintRequest | string {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 72 && v <= 5000 ? v : null
  if (typeof r.html !== 'string' || !r.html || r.html.length > MAX_HTML) return 'bad html'
  const widthPt = num(r.widthPt)
  const heightPt = num(r.heightPt)
  if (widthPt === null || heightPt === null) return 'bad page size'
  const pages = typeof r.pages === 'number' && r.pages >= 1 && r.pages <= 5000 ? r.pages : 1
  if (r.mode !== 'print' && r.mode !== 'pdf') return 'bad mode'
  if (r.mode === 'pdf') {
    if (!isBoundedString(r.targetPath, MAX_PATH_LENGTH) || !dialogPaths.has(r.targetPath))
      return 'target path was not chosen in a save dialog'
  }
  return {
    html: r.html,
    widthPt,
    heightPt,
    pages,
    mode: r.mode,
    targetPath: typeof r.targetPath === 'string' ? r.targetPath : undefined
  }
}

async function loadPrintPage(win: BrowserWindow): Promise<void> {
  if (process.env.ELECTRON_RENDERER_URL)
    await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/print.html`)
  else await win.loadFile(join(__dirname, '../renderer/print.html'))
}

export async function printSheets(req: PrintRequest): Promise<PrintResult> {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1100,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      webviewTag: false,
      javascript: true
    }
  })
  try {
    await loadPrintPage(win)
    const wc = win.webContents
    await wc.insertCSS(`@page { size: ${req.widthPt}pt ${req.heightPt}pt; margin: 0 }`)
    const sheets = (await wc.executeJavaScript(
      `(async () => {
        document.getElementById('sheets').innerHTML = ${JSON.stringify(req.html)};
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        await document.fonts.ready;
        return document.querySelectorAll('.print-sheet').length;
      })()`
    )) as number
    if (!sheets) return { ok: false, error: 'لا توجد صفحات للطباعة.' }
    if (req.mode === 'pdf') {
      const pdf = await wc.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      })
      const target = req.targetPath as string
      const tmp = `${target}.~mizaj_tmp`
      await writeFile(tmp, pdf)
      await rename(tmp, target)
      return { ok: true, pages: sheets }
    }
    return await new Promise<PrintResult>((resolve) => {
      wc.print(
        {
          silent: false,
          printBackground: true,
          margins: { marginType: 'none' },
          pageSize: {
            width: Math.round(req.widthPt * MICRONS_PER_PT),
            height: Math.round(req.heightPt * MICRONS_PER_PT)
          }
        },
        (success, reason) =>
          resolve(
            success || reason === 'cancelled' || reason === 'Print job canceled'
              ? { ok: true, pages: sheets }
              : { ok: false, error: reason || 'تعذرت الطباعة.' }
          )
      )
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'تعذرت الطباعة.' }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
