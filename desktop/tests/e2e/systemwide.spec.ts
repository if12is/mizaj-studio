import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * «مِزَاج في أي برنامج»: the settings page and the popup's in-app behaviour. The OS automation
 * (keystrokes, clipboard, Word COM) is replaced by a mock (MIZAJ_E2E_SYSTEMWIDE_MOCK, honoured only
 * by an unpackaged build); the real engine and the real popup window are used. Real Windows/Word
 * automation is covered by the Windows CI smoke test (.github/workflows/windows-e2e.yml).
 */
const desktopDir = resolve(__dirname, '../..')
let app: ElectronApplication
let page: Page
let userData: string

const t = (id: string) => page.getByTestId(id)
type W = {
  mizajAPI: {
    systemwide: {
      popupApply(): Promise<void>
      setConfig(p: unknown): Promise<unknown>
      popupRun(o: unknown): Promise<void>
    }
  }
}

interface Hook {
  auto: {
    setPlain(t: string): void
    setHtml(h: string, t: string): void
    setWord(t: string): void
    error: string | null
    applied: { how: string; plain?: string; html?: string; edits?: unknown[] }[]
    calls: string[]
  }
  notices: { message: string; kind: string }[]
  trigger(id: string): Promise<void>
  fire(acc: string): void
  state(): { phase: string } | null
  registered(): string[]
}
const hook = <T>(fn: (h: Hook, arg: never) => T, arg?: unknown): Promise<T> =>
  app.evaluate(
    (_e, a) => {
      const h = (globalThis as unknown as { __mizajSystemwide: Hook }).__mizajSystemwide
      return (a as { fn: string; arg: unknown }).fn
        ? (new Function('h', 'arg', `return (${(a as { fn: string }).fn})(h, arg)`)(
            h,
            (a as { arg: unknown }).arg
          ) as T)
        : (undefined as T)
    },
    { fn: fn.toString(), arg }
  )

async function popup(): Promise<Page> {
  await expect
    .poll(() => app.windows().some((w) => w.url().includes('popup=1')), { timeout: 20_000 })
    .toBe(true)
  const p = app.windows().find((w) => w.url().includes('popup=1')) as Page
  await p.waitForLoadState('domcontentloaded')
  return p
}

async function openTab(): Promise<void> {
  if (!(await t('settings-modal').isVisible())) await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await t('tab-systemwide').click()
  await expect(t('systemwide-settings')).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-sw-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_E2E_SYSTEMWIDE_MOCK: '1'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(userData, { recursive: true, force: true })
})

test('everything is off by default and explained in Arabic', async () => {
  await openTab()
  await expect(t('sw-explainer')).toContainText('مع الحفاظ على تنسيقه')
  await expect(t('sw-explainer')).toContainText('دون إنترنت')
  await expect(t('sw-enabled')).not.toBeChecked()
  await expect(t('sw-background')).not.toBeChecked()
  await expect(t('sw-mode-preview')).toBeChecked()
  await expect(t('sw-mode-direct')).not.toBeChecked()
  await expect(t('sw-shortcut-main')).toHaveValue('Ctrl+Alt+M')
  for (const id of ['proofread', 'punctuation', 'tashkeel', 'all'])
    await expect(t(`sw-shortcut-${id}`)).toHaveValue('')
  await expect(t('sw-limits')).toContainText('Administrator')
  expect(await hook((h) => h.registered())).toEqual([]) // nothing registered while off
  // the settings tab lives under «إعدادات متقدمة» only
  await t('settings-mode-basic').click()
  await expect(t('tab-systemwide')).toHaveCount(0)
})

test('enabling registers the shortcut, disabling releases it, config persists without any text', async () => {
  await openTab()
  await t('sw-enabled').check()
  await expect(t('sw-status-main')).toHaveText('مفعّل')
  expect(await hook((h) => h.registered())).toEqual(['Ctrl+Alt+M'])
  await t('sw-enabled').uncheck()
  await expect(t('sw-status-main')).toHaveCount(0)
  expect(await hook((h) => h.registered())).toEqual([])
  await t('sw-enabled').check()
  const file = join(userData, 'systemwide-config.json')
  expect(existsSync(file)).toBe(true)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  expect(saved).toMatchObject({ enabled: true, replaceMode: 'preview', runInBackground: false })
  expect(Object.keys(saved).sort()).toEqual([
    'enabled',
    'replaceMode',
    'runInBackground',
    'shortcuts'
  ])
})

test('shortcut recorder: sets, validates, detects a conflict with another program', async () => {
  await openTab()
  // physical key, modifiers required
  await t('sw-shortcut-tashkeel').press('Control+Alt+T')
  await expect(t('sw-shortcut-tashkeel')).toHaveValue('Ctrl+Alt+T')
  await expect(t('sw-status-tashkeel')).toHaveText('مفعّل')
  expect(await hook((h) => h.registered())).toEqual(['Ctrl+Alt+M', 'Ctrl+Alt+T'])

  // reserved combination is refused with an explanation and the old value stays
  await t('sw-shortcut-all').press('Control+C')
  await expect(t('sw-error-all')).toContainText('محجوز')
  await expect(t('sw-shortcut-all')).toHaveValue('')
  // no modifier
  await t('sw-shortcut-all').press('KeyQ')
  await expect(t('sw-error-all')).toContainText('Ctrl أو Alt')
  // duplicate of another action
  await t('sw-shortcut-all').press('Control+Alt+T')
  await expect(t('sw-error-all')).toContainText('مستعمل لإجراء آخر')

  // another program owns Ctrl+Alt+K: globalShortcut.register returns false -> the user is told
  const taken = await app.evaluate(({ globalShortcut }) =>
    globalShortcut.register('Ctrl+Alt+K', () => {})
  )
  expect(taken).toBe(true)
  await t('sw-shortcut-punctuation').press('Control+Alt+K')
  await expect(t('sw-status-punctuation')).toHaveText('تعارض')
  await expect(t('sw-error-punctuation')).toContainText('يستعمله برنامج آخر')
  await app.evaluate(({ globalShortcut }) => globalShortcut.unregister('Ctrl+Alt+K'))

  // clearing releases it
  await t('sw-clear-punctuation').click()
  await t('sw-clear-tashkeel').click()
  await expect(t('sw-shortcut-tashkeel')).toHaveValue('')
  expect(await hook((h) => h.registered())).toEqual(['Ctrl+Alt+M'])
})

test('popup: 4 buttons, key 3 previews tashkeel with highlighted changes, Enter replaces', async () => {
  await hook((h) => h.auto.setPlain('هذا كتاب جميل جدا'))
  await hook((h) => h.trigger('main'))
  const p = await popup()
  await expect(p.getByTestId('sw-popup')).toBeVisible()
  expect(await p.evaluate(() => document.documentElement.dir)).toBe('rtl')
  await expect(p.getByTestId('sw-snippet')).toHaveText('هذا كتاب جميل جدا')
  await expect(p.getByTestId('sw-source')).toContainText('نص عادي')
  for (const [id, label] of [
    ['proofread', 'تدقيق إملائي'],
    ['punctuation', 'ترقيم'],
    ['tashkeel', 'تشكيل'],
    ['all', 'الكل']
  ])
    await expect(p.getByTestId(`sw-op-${id}`)).toContainText(label)
  await expect(p.getByTestId('sw-replace')).toBeDisabled() // nothing to replace before an operation

  await p.keyboard.press('3')
  await expect(p.getByTestId('sw-preview')).toBeVisible()
  await expect(p.getByTestId('sw-change').first()).toBeVisible()
  // the preview shows the diacritized words, highlighted, and nothing was replaced yet
  const marked = await p.getByTestId('sw-change').allTextContents()
  expect(marked.join(' ')).toMatch(/[ً-ْ]/)
  expect(await hook((h) => h.auto.applied.length)).toBe(0)

  await p.keyboard.press('Enter')
  await expect.poll(() => hook((h) => h.auto.applied.length)).toBe(1)
  const a = await hook((h) => h.auto.applied[0])
  expect(a.how).toBe('paste')
  expect(a.plain).toMatch(/[ً-ْ]/)
  // base letters untouched: removing the marks gives the original text back
  expect((a.plain as string).replace(/[ً-ْ]/g, '')).toBe('هذا كتاب جميل جدا')
  await expect.poll(() => hook((h) => h.state())).toBeNull()
  expect((await hook((h) => h.notices)).at(-1)?.message).toContain('تم الاستبدال')
})

test('popup: proofread and punctuation operate on their own categories only', async () => {
  await hook((h) => h.auto.setPlain('قال ابو زيد فى الدار ،ثم ذهب'))
  await hook((h) => h.trigger('main'))
  const p = await popup()
  await p.getByTestId('sw-op-proofread').click()
  await expect(p.getByTestId('sw-preview')).toBeVisible()
  const text1 = (await p.getByTestId('sw-preview').textContent()) ?? ''
  expect(text1).toContain('أبو') // hamza fixed
  expect(text1).toContain('في') // ya fixed
  expect(text1).toContain('،ثم') // punctuation left alone by «تدقيق إملائي»
  await p.keyboard.press('2')
  await expect(p.getByTestId('sw-op-punctuation')).toHaveAttribute('aria-pressed', 'true')
  await expect(p.getByTestId('sw-preview')).toContainText('، ثم')
  const text2 = (await p.getByTestId('sw-preview').textContent()) ?? ''
  expect(text2).toContain('ابو') // letters left alone by «ترقيم»
  expect(text2).toContain('فى')
  await p.keyboard.press('Escape') // cancel
  await expect.poll(() => hook((h) => h.state())).toBeNull()
  expect(await hook((h) => h.auto.applied.length)).toBe(1) // still just the first test's replacement
})

test('popup: short-text warning for tashkeel, no-change message, error message', async () => {
  await hook((h) => h.auto.setPlain('كتاب جميل'))
  await hook((h) => h.trigger('main'))
  let p = await popup()
  await p.getByTestId('sw-op-tashkeel').click()
  await expect(p.getByTestId('sw-warning')).toContainText('النص قصير')
  await expect(p.getByTestId('sw-warning')).toContainText('4 كلمات')
  await p.getByTestId('sw-cancel').click()

  await hook((h) => h.auto.setPlain('هذا نص سليم تماما'))
  await hook((h) => h.trigger('main'))
  p = await popup()
  await p.getByTestId('sw-op-punctuation').click()
  await expect(p.getByTestId('sw-nochange')).toBeVisible()
  await expect(p.getByTestId('sw-replace')).toBeDisabled()
  await p.keyboard.press('Escape')

  await hook((h) => h.auto.setPlain('hello world'))
  await hook((h) => h.trigger('main'))
  p = await popup()
  await p.getByTestId('sw-op-all').click()
  await expect(p.getByTestId('sw-error')).toContainText('لا يوجد نص عربي')
  await p.getByTestId('sw-popup-close').click()
  await expect.poll(() => hook((h) => h.state())).toBeNull()
})

test('popup window is frameless, always on top, sandboxed; IPC is restricted per window', async () => {
  await hook((h) => h.auto.setPlain('هذا كتاب جميل جدا'))
  await hook((h) => h.trigger('main'))
  const p = await popup()
  const info = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popup=1'))
    if (!w) return null
    const prefs = (
      w.webContents as unknown as {
        getLastWebPreferences(): {
          sandbox?: boolean
          contextIsolation?: boolean
          nodeIntegration?: boolean
        }
      }
    ).getLastWebPreferences()
    return {
      alwaysOnTop: w.isAlwaysOnTop(),
      resizable: w.isResizable(),
      visible: w.isVisible(),
      sandboxed: prefs.sandbox,
      isolated: prefs.contextIsolation,
      node: prefs.nodeIntegration
    }
  })
  // frameless = no title bar: content and window heights match. The window manager may still be
  // settling the bounds right after the popup shows, so poll instead of reading once.
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.webContents.getURL().includes('popup=1')
        )
        return w ? w.getContentBounds().height === w.getBounds().height : null
      })
    )
    .toBe(true)
  expect(info).toMatchObject({
    alwaysOnTop: true,
    resizable: false,
    visible: true,
    sandboxed: true,
    isolated: true,
    node: false
  })
  // the main window may not drive the popup, and the popup may not read or change settings
  const mainErr = await page.evaluate(() =>
    (window as unknown as W).mizajAPI.systemwide.popupApply().then(
      () => 'ok',
      (e: Error) => String(e.message)
    )
  )
  expect(mainErr).toContain('not the popup')
  const popErr = await p.evaluate(() =>
    (window as unknown as W).mizajAPI.systemwide.setConfig({ enabled: false }).then(
      () => 'ok',
      (e: Error) => String(e.message)
    )
  )
  expect(popErr).toContain('popup may not change settings')
  // invalid input is ignored, not executed
  await p.evaluate(() => (window as unknown as W).mizajAPI.systemwide.popupRun('rm -rf'))
  expect((await hook((h) => h.state()))?.phase).toBe('choose')
  await p.keyboard.press('Escape')
  await expect.poll(() => hook((h) => h.state())).toBeNull()
})

test('capture failures are announced in Arabic, never silently', async () => {
  await hook((h) => h.auto.setPlain('هذا كتاب جميل جدا'))
  const before = (await hook((h) => h.notices.length)) as number
  await hook((h) => {
    h.auto.error = 'no_selection'
  })
  await hook((h) => h.trigger('tashkeel'))
  await expect.poll(() => hook((h) => h.notices.length)).toBe(before + 1)
  expect((await hook((h) => h.notices)).at(-1)).toEqual({
    message: 'لم يُنسخ أي نص محدد. حدّد نصاً ثم أعد المحاولة.',
    kind: 'error'
  })
  await hook((h) => {
    h.auto.error = 'elevated'
  })
  await hook((h) => h.trigger('main'))
  expect((await hook((h) => h.notices)).at(-1)?.message).toContain('Administrator')
  await hook((h) => {
    h.auto.error = null
  })
})

test('direct replace mode: the operation shortcut replaces at once, rich HTML keeps its tags', async () => {
  await openTab()
  await t('sw-mode-direct').check()
  await expect(t('sw-mode-direct')).toBeChecked()
  await t('sw-shortcut-all').press('Control+Alt+L')
  await expect(t('sw-status-all')).toHaveText('مفعّل')
  const html =
    '<html><body><!--StartFragment--><p class=MsoNormal><b style="color:red">كتاب</b> <i>جميل</i> جدا اليوم</p><!--EndFragment--></body></html>'
  await hook((h, a) => h.auto.setHtml((a as { html: string }).html, 'كتاب جميل جدا اليوم'), {
    html
  })
  const n = (await hook((h) => h.auto.applied.length)) as number
  await hook((h) => h.fire('Ctrl+Alt+L')) // simulated OS shortcut delivery
  await expect.poll(() => hook((h) => h.auto.applied.length)).toBe(n + 1)
  const a = await hook((h) => h.auto.applied.at(-1))
  expect(a?.how).toBe('paste')
  const out = a?.html as string
  // tags and attributes identical; only text nodes gained marks
  expect(out.replace(/[^<>]+(?=<)/g, '')).toBe(html.replace(/[^<>]+(?=<)/g, ''))
  expect(out).toContain('<b style="color:red">')
  expect(out).toMatch(/<i>[^<]*[ً-ْ][^<]*<\/i>/)
  expect(await hook((h) => h.state())).toBeNull() // no popup in direct mode
  expect(
    app
      .windows()
      .filter((w) => w.url().includes('popup=1'))
      .every((w) => w.isClosed())
  ).toBe(false) // popup window exists but stayed hidden
  await t('sw-mode-preview').check()
  await t('sw-clear-all').click()
})

test('Word selection is edited through minimal edits (never a whole-text replacement)', async () => {
  await hook((h) => h.auto.setWord('هذا كتاب\rجميل جدا'))
  await openTab()
  await t('sw-mode-direct').check()
  await hook((h) => h.trigger('tashkeel'))
  await expect.poll(() => hook((h) => h.auto.calls.includes('applyWord'))).toBe(true)
  const w = await hook((h) => h.auto.applied.at(-1))
  expect(w?.how).toBe('word')
  const edits = w?.edits as { start: number; end: number; insert: string }[]
  expect(edits.length).toBeGreaterThan(0)
  expect(edits.every((e) => e.start === e.end && /^[ً-ْ]+$/.test(e.insert))).toBe(true)
  await t('sw-mode-preview').check()
})

test('background mode is a plain opt-in switch', async () => {
  await openTab()
  await expect(t('sw-background')).not.toBeChecked()
  await t('sw-background').check()
  await expect(t('sw-background')).toBeChecked()
  const saved = JSON.parse(readFileSync(join(userData, 'systemwide-config.json'), 'utf8'))
  expect(saved.runInBackground).toBe(true)
  await t('sw-background').uncheck()
  await t('sw-enabled').uncheck()
  expect(await hook((h) => h.registered())).toEqual([])
})

test('without background mode, closing the main window quits the app even though the popup exists', async () => {
  // the hidden popup window must not keep the process alive
  expect(app.windows().some((w) => w.url().includes('popup=1'))).toBe(true)
  const exited = new Promise<void>((ok) => app.process().once('exit', () => ok()))
  await page.evaluate(() =>
    (window as unknown as { mizajAPI: { windowClose(): Promise<void> } }).mizajAPI.windowClose()
  )
  await Promise.race([
    exited,
    new Promise<void>((_, no) => setTimeout(() => no(new Error('app did not quit')), 30_000))
  ])
})
