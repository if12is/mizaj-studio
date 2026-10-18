// Shared helpers for the exploratory QA scripts (NOT part of `npm run test:e2e`).
// Run: xvfb-run -a node tests/qa/explore.mjs   (from desktop/, after `npx electron-vite build`)
// Env: REAL=1 uses the real engine (needs MIZAJ_MODELS_DIR + MIZAJ_PYTHON), QA_DOC=<in.docx>,
//      QA_OUT=<scratch dir for screenshots and findings.log>.
import { _electron as electron } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESK = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const OUT = process.env.QA_OUT || mkdtempSync(join(tmpdir(), 'mizaj-qa-report-'))
export const DOC = process.env.QA_DOC || ''
mkdirSync(join(OUT, 'shots'), { recursive: true })

export function note(kind, msg) {
  const line = `[${kind}] ${msg}`
  console.log(line)
  appendFileSync(join(OUT, 'findings.log'), line + '\n')
}

export async function launch(extraEnv = {}, userDataDir = null) {
  const userData = userDataDir || mkdtempSync(join(tmpdir(), 'mizaj-qa-'))
  const outDir = mkdtempSync(join(tmpdir(), 'mizaj-qa-out-'))
  const engine = process.env.REAL ? {} : { MIZAJ_ENGINE_MODE: 'mock' }
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: DESK,
    env: {
      ...process.env,
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E: '1',
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_E2E_SAVE_PATH: join(outDir, 'exported.docx'),
      ...engine,
      ...extraEnv
    }
  })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1400, height: 900 })
  // everything the owner would call "an error": console errors, failed requests, 4xx/5xx
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      note('console.' + m.type(), m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => note('pageerror', String(e).slice(0, 300)))
  page.on('response', (r) => {
    if (r.status() >= 400) note('http' + r.status(), r.request().method() + ' ' + r.url())
  })
  page.on('requestfailed', (r) => note('reqfailed', r.url().slice(0, 150)))
  await page.getByTestId('status-sidecar').filter({ hasText: 'جاهز' }).waitFor({ timeout: 90000 })
  return { app, page, userData, outDir }
}

export const shot = (page, name) => page.screenshot({ path: join(OUT, 'shots', `${name}.png`) })
export const t = (page, id) => page.getByTestId(id)
export const has = async (page, id) => (await page.getByTestId(id).count()) > 0

/** A toast that is raw/English is a bug: flag it. */
export async function checkToast(page, where) {
  if ((await t(page, 'toasts').count()) === 0) return ''
  const txt = (await t(page, 'toasts').innerText()).replace(/\n+/g, ' / ').trim()
  const bare = txt
    .replace(/\S*\/\S+/g, '')
    .replace(/Tanzil|DOCX|Word|OCR|Tesseract|PDF|JSON|Windows|\.mizajpack|CC BY|HTTP/gi, '')
  if (/[A-Za-z]{5,}/.test(bare) || /(exception|traceback|ERR_|undefined|\[object)/i.test(txt))
    note('RAW-OR-ENGLISH-TOAST', `${where}: ${txt}`)
  return txt
}
