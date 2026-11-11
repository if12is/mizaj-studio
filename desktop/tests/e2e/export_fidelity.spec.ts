import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
const FIXTURE = resolve(desktopDir, '../backend/tests/fixtures/fidelity/legal_memo.docx')
const BEFORE = 'المحاماه'
const AFTER = 'المحاماة'

let app: ElectronApplication
let page: Page
let userData: string
let work: string
let source: string

const t = (id: string) => page.getByTestId(id)
type CM = {
  cmView: {
    view: {
      state: { doc: { toString(): string } }
      dispatch(s: unknown): void
    }
  }
}
const docText = () =>
  page.evaluate(() =>
    (document.querySelector('.cm-content') as unknown as CM).cmView.view.state.doc.toString()
  )
const stub = (key: 'SAVE' | 'OPEN', value: string) =>
  app.evaluate(
    (_, [k, v]) => {
      process.env[`MIZAJ_E2E_${k}_PATH`] = v
    },
    [key, value]
  )

function zipMembers(path: string): string[] {
  return execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).split('\n').filter(Boolean)
}
function member(path: string, name: string): Buffer {
  // unzip treats member names as globs: escape [Content_Types].xml
  return execFileSync('unzip', ['-p', path, name.replace(/[[\]*?\\]/g, '\\$&')], {
    maxBuffer: 1 << 28
  })
}
const documentXml = (path: string): string => member(path, 'word/document.xml').toString('utf8')
const stripText = (xml: string): string => xml.replace(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g, '')
/** visible text after dropping deletions and unwrapping insertions */
function acceptedText(xml: string): string {
  const noDel = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '')
  return (noDel.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) ?? [])
    .map((x) => x.replace(/<[^>]+>/g, ''))
    .join('')
}

async function exportTo(target: string, run: () => Promise<void>): Promise<void> {
  await stub('SAVE', target)
  await run()
  await expect.poll(() => existsSync(target), { timeout: 60_000 }).toBe(true)
  // the sidecar replaces the file atomically; make sure the final write is there
  await expect.poll(() => zipMembers(target).length > 0, { timeout: 15_000 }).toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-fid-'))
  work = mkdtempSync(join(tmpdir(), 'mizaj-e2e-fid-work-'))
  source = join(work, 'legal_memo.docx')
  copyFileSync(FIXTURE, source)
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

test('every Word export keeps the original file and carries only the text edit', async () => {
  // 1. import through the UI with the native open dialog stubbed
  await stub('OPEN', source)
  await t('file-menu').click()
  await t('file-import').click()
  await expect.poll(docText, { timeout: 30_000 }).toContain(BEFORE)

  // 2. a proofreading-like edit, then wait for autosave
  await page.evaluate(
    ([from, to]) => {
      const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
      const text = v.state.doc.toString()
      const i = text.indexOf(from)
      v.dispatch({ changes: { from: i, to: i + from.length, insert: to } })
    },
    [BEFORE, AFTER]
  )
  expect(await docText()).toContain(AFTER)
  // no waiting for the debounce: the exports must flush unsaved text themselves

  // 3. exports: toolbar, File menu, tracked entries
  const toolbar = join(work, 'toolbar.docx')
  await exportTo(toolbar, () => t('export-docx').click())

  const menu = join(work, 'menu.docx')
  await exportTo(menu, async () => {
    await t('file-menu').click()
    await t('file-export-docx').click()
  })

  const trackedOpts = join(work, 'tracked-options.docx')
  await exportTo(trackedOpts, async () => {
    await t('file-menu').click()
    await t('file-export-docx-track-edits').click()
    await expect(t('tracked-dialog')).toBeVisible()
    await t('tracked-confirm').click()
  })

  const trackedDefault = join(work, 'tracked-default.docx')
  await exportTo(trackedDefault, async () => {
    await t('file-menu').click()
    await t('file-export-docx-track').click()
  })

  // 4. assertions on the files
  const src = documentXml(source)
  const a = documentXml(toolbar)
  const b = documentXml(menu)
  expect(a).toBe(b) // both buttons: byte-identical document.xml
  expect(a).toContain(AFTER)
  expect(a).not.toContain(BEFORE)
  expect(stripText(a)).toBe(stripText(src)) // only text differs from the original XML

  for (const out of [toolbar, menu, trackedOpts, trackedDefault]) {
    expect(zipMembers(out).sort(), out).toEqual(zipMembers(source).sort())
    for (const name of zipMembers(source)) {
      if (name === 'word/document.xml') continue
      expect(member(out, name).equals(member(source, name)), `${out}: ${name}`).toBe(true)
    }
  }

  for (const out of [trackedOpts, trackedDefault]) {
    const x = documentXml(out)
    expect(x).toMatch(/<w:ins /)
    expect(x).toMatch(/<w:del /)
    expect(acceptedText(x)).toContain(AFTER)
  }
  // «تصدير بتتبع التغييرات» now reflects the user's edits exactly like the entry with options
  expect(acceptedText(documentXml(trackedDefault))).toBe(acceptedText(documentXml(trackedOpts)))
})
