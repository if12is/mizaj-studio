import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const desktopDir = resolve(__dirname, '../..')
const GOOD_KEY = 'AIzaSyE2EFAKEKEYFORTESTS1234567890xyz'
const SENTENCE = 'ذهب الولد إلى المدرسة'
let app: ElectronApplication
let page: Page
let userData: string
let fake: Server
let wordReply =
  'السؤال عن الإعراب: الفاعل مرفوع.\n```mizaj-suggestion\nذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ\n```'
let failStatus: number | null = null
type Fake = { status?: number; json: unknown }
let override: ((body: string) => Fake | null) | null = null
/** «hold» mode: the next stream sends its first chunk after firstDelayMs, then waits for release or disconnect. */
let hold: { firstDelayMs: number; first: string; released: boolean } | null = null
let holdClosed = false
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))
const requests: { method: string; url: string; key: string | undefined; body: string }[] = []
const gen = () => requests.filter((r) => r.url.includes(':streamGenerateContent'))

const t = (id: string) => page.getByTestId(id)
type CM = {
  cmView: {
    view: {
      state: { doc: { toString(): string; length: number } }
      dispatch(s: unknown): void
      focus(): void
    }
  }
}
const docText = () =>
  page.evaluate(() =>
    (document.querySelector('.cm-content') as unknown as CM).cmView.view.state.doc.toString()
  )
const setDoc = (txt: string, anchor = 0) =>
  page.evaluate(
    ([x, a]) => {
      const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: x },
        selection: { anchor: a }
      })
      v.focus()
    },
    [txt, anchor] as const
  )
const api = <T = unknown>(path: string): Promise<T> =>
  page.evaluate(async (p) => {
    const cfg = await (
      window as unknown as {
        mizajAPI: { getBackendConfig(): Promise<{ baseUrl: string; token: string }> }
      }
    ).mizajAPI.getBackendConfig()
    return (await fetch(`${cfg.baseUrl}${p}`, { headers: { 'X-Mizaj-Token': cfg.token } })).json()
  }, path) as Promise<T>

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-e2e-gemini-'))
  fake = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const key = req.headers['x-goog-api-key'] as string | undefined
      requests.push({ method: req.method ?? '', url: req.url ?? '', key, body })
      res.setHeader('Content-Type', 'application/json')
      if (key !== GOOD_KEY) {
        res.statusCode = 400
        res.end(
          JSON.stringify({
            error: {
              status: 'INVALID_ARGUMENT',
              message: 'API key not valid. Please pass a valid API key.'
            }
          })
        )
        return
      }
      if (req.url?.startsWith('/v1beta/models?')) {
        const m = (name: string, methods = ['generateContent']) => ({
          name: `models/${name}`,
          displayName: name,
          supportedGenerationMethods: methods
        })
        res.end(
          JSON.stringify({
            models: [
              m('gemini-1.5-pro'),
              m('gemini-2.0-flash'),
              m('embedding-001', ['embedContent']),
              m('gemini-2.5-pro'),
              m('gemini-2.5-flash'),
              m('gemini-3-flash-preview'),
              m('gemini-3.1-flash-lite-preview'),
              m('gemini-3-pro-image-preview'),
              m('gemini-flash-latest')
            ]
          })
        )
        return
      }
      const isGen = !!req.url?.includes(':streamGenerateContent')
      const ov = isGen ? override?.(body) : null
      if (ov && (ov.status ?? 200) >= 400) {
        res.statusCode = ov.status!
        res.end(JSON.stringify(ov.json))
        return
      }
      if (isGen && failStatus) {
        res.statusCode = failStatus
        res.end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }))
        return
      }
      if (isGen && hold) {
        const h = hold
        hold = null
        holdClosed = false
        res.on('close', () => (holdClosed = true))
        res.setHeader('Content-Type', 'text/event-stream')
        void (async () => {
          await sleepMs(h.firstDelayMs)
          if (holdClosed) return
          res.write(
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: h.first }] } }] })}\r\n\r\n`
          )
          for (let i = 0; i < 200 && !h.released && !holdClosed; i++) await sleepMs(100)
          if (!holdClosed) res.end()
        })()
        return
      }
      if (isGen) {
        const isWord = body.includes('الكلمة المقصودة')
        const json =
          ov?.json ??
          ({
            candidates: [
              {
                content: { parts: [{ text: isWord ? wordReply : 'هذا جواب عن المستند.' }] },
                finishReason: 'STOP'
              }
            ]
          } as unknown)
        // stream it as SSE: every text part is cut in two events (and a thinking part is passed through)
        const cand = (
          json as {
            candidates?: {
              content?: { parts?: Record<string, unknown>[] }
              finishReason?: string
            }[]
            promptFeedback?: unknown
          }
        ).candidates?.[0]
        res.setHeader('Content-Type', 'text/event-stream')
        const ev = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\r\n\r\n`)
        if (!cand) {
          ev(json)
          res.end()
          return
        }
        for (const part of cand.content?.parts ?? []) {
          const text = typeof part.text === 'string' ? part.text : ''
          const cut = Math.floor(text.length / 2)
          for (const piece of text.length > 3 && !part.thought
            ? [text.slice(0, cut), text.slice(cut)]
            : [text])
            ev({ candidates: [{ content: { parts: [{ ...part, text: piece }] } }] })
        }
        ev({
          candidates: [{ finishReason: cand.finishReason }],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 7,
            thoughtsTokenCount: 5,
            totalTokenCount: 23
          }
        })
        res.end()
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok))
  const port = (fake.address() as AddressInfo).port
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: {
      ...process.env,
      MIZAJ_ENGINE_MODE: 'mock',
      MIZAJ_USER_DATA_DIR: userData,
      MIZAJ_E2E_NO_SHELL: '1',
      MIZAJ_E2E_FAKE_SAFESTORAGE: '1',
      MIZAJ_GEMINI_BASE_URL: `http://127.0.0.1:${port}`
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(t('status-sidecar')).toContainText('المحرك: جاهز')
  await t('new-project').click()
  await t('new-project-input').fill('جيميني')
  await t('new-project-input').press('Enter')
  await expect(t('project-item')).toHaveCount(1)
  await t('new-document').first().click()
  await t('new-document-input').fill('مستند')
  await t('new-document-input').press('Enter')
  await expect(t('doc-title')).toHaveText('مستند')
})
test.afterAll(async () => {
  await app?.close()
  fake?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('Gemini is off by default: no toolbar button, no network, no word-box', async () => {
  await expect(t('toggle-gemini-panel')).toHaveCount(0)
  await setDoc(SENTENCE, 6)
  await page.keyboard.press('Control+.')
  await expect(t('inspector')).toBeVisible()
  await expect(t('gemini-ask')).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(requests).toHaveLength(0)
})

test('enable, key rejected then accepted, live model list, key stored encrypted', async () => {
  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await t('tab-online').click()
  await expect(t('gemini-settings')).toBeVisible()
  await expect(t('gemini-enable')).not.toBeChecked()
  await expect(t('gemini-api-box')).toHaveCount(0)
  await t('gemini-enable').check()
  await expect(t('gemini-api-box')).toBeVisible()

  // the key field is masked until «إظهار»
  await t('gemini-key-input').fill('AIzaSyWRONGKEYWRONGKEYWRONGKEY12345')
  await expect(t('gemini-key-input')).toHaveAttribute('type', 'password')
  await t('gemini-key-reveal').click()
  await expect(t('gemini-key-input')).toHaveAttribute('type', 'text')
  await t('gemini-key-reveal').click()
  await t('gemini-key-test').click()
  await expect(t('gemini-message')).toContainText('غير صالح')

  // no format validation: a key of another shape is sent to Google, which rejects it
  await t('gemini-key-input').fill('AQ.Ab8RN6SomeOtherShapeOfKey')
  await t('gemini-key-save').click()
  await expect(t('gemini-message')).toContainText('غير صالح')
  await expect(t('gemini-key-hint')).toHaveCount(0) // a rejected key is not kept
  // spaces inside are refused locally
  await t('gemini-key-input').fill('AIza with spaces')
  await t('gemini-key-save').click()
  await expect(t('gemini-message')).toContainText('مسافات')

  await t('gemini-key-input').fill(GOOD_KEY)
  await t('gemini-key-test').click()
  await expect(t('gemini-message')).toContainText('المفتاح صالح ✓')
  await t('gemini-key-save').click()
  await expect(t('gemini-message')).toContainText('المفتاح صالح ✓')
  await expect(t('gemini-key-hint')).toContainText('xyz')
  await expect(t('gemini-key-hint')).not.toContainText('E2EFAKE')
  await expect(t('gemini-key-input')).toHaveValue('') // never echoed back

  // models come from the API: embedding-only excluded, newest first, newest flash preselected
  const sel = t('gemini-model-select')
  await expect(sel.locator('option')).toHaveText([
    'gemini-flash-latest',
    'gemini-3.1-flash-lite-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-pro'
  ])
  // the latest Flash ids are listed (not filtered); image/embedding models are not
  await expect(sel).toHaveValue('gemini-flash-latest')
  await sel.selectOption('gemini-2.0-flash')

  // advanced: the idle timeout (default 90 s) is configurable and persisted
  await expect(t('gemini-idle-timeout')).toHaveValue('90')
  await t('gemini-idle-timeout').fill('120')
  await t('gemini-idle-timeout').blur()
  await expect
    .poll(
      () => JSON.parse(readFileSync(join(userData, 'gemini-config.json'), 'utf8')).idleTimeoutSec
    )
    .toBe(120)

  // the key header was used; the key never appears in URLs
  expect(requests.some((r) => r.key === GOOD_KEY && r.url.startsWith('/v1beta/models?'))).toBe(true)
  expect(requests.every((r) => !r.url.includes(GOOD_KEY))).toBe(true)

  // on disk: encrypted blob only, and the key is not in the renderer-visible settings DB
  const files = readdirSync(userData)
  expect(files).toContain('gemini-key.bin')
  expect(readFileSync(join(userData, 'gemini-key.bin')).toString('utf8')).not.toContain(GOOD_KEY)
  expect(readFileSync(join(userData, 'gemini-config.json'), 'utf8')).not.toContain(GOOD_KEY)
  expect(JSON.stringify(await api('/api/settings'))).not.toContain(GOOD_KEY)
  expect(await page.evaluate(() => document.documentElement.outerHTML.includes('E2EFAKEKEY'))).toBe(
    false
  )

  // the removed CLI mode leaves no UI behind
  await expect(t('gemini-cli-box')).toHaveCount(0)
  await expect(t('gemini-provider')).toHaveCount(0)
  await t('settings-close').click()
})

test('ask about the document: consent first (decline sends nothing), shown only once', async () => {
  await setDoc('هذا نص تجريبي للمستند', 0)
  await expect(t('toggle-gemini-panel')).toBeVisible()
  await t('toggle-gemini-panel').click()
  await t('gemini-question').fill('ما الأخطاء في هذا النص؟')
  await t('gemini-send').click()
  await expect(t('gemini-consent')).toBeVisible()
  await expect(t('gemini-consent')).toContainText('إلى Google')
  await t('gemini-consent-decline').click()
  await expect(t('gemini-error')).toBeVisible()
  expect(gen()).toHaveLength(0) // nothing was sent without consent

  await t('gemini-question').fill('ما الأخطاء في هذا النص؟')
  await t('gemini-send').click()
  await expect(t('gemini-consent')).toBeVisible() // declined before, so asked again
  await t('gemini-consent-accept').click()
  await expect(t('gemini-answer').first()).toContainText('هذا جواب عن المستند')
  await expect(t('gemini-usage').first()).toContainText('التفكير 5') // usageMetadata, thoughts counted not shown
  expect(gen()).toHaveLength(1)
  expect(gen()[0].url).toContain('models/gemini-2.0-flash:streamGenerateContent')
  expect(gen()[0].key).toBe(GOOD_KEY)
  expect(gen()[0].body).toContain('هذا نص تجريبي للمستند')
  expect(gen()[0].body).not.toContain(GOOD_KEY)

  await t('gemini-question').fill('سؤال ثان')
  await t('gemini-send').click()
  await expect(t('gemini-answer')).toHaveCount(2)
  await expect(t('gemini-consent')).toHaveCount(0) // accepted once, never again
  expect(gen()).toHaveLength(2)
  await t('right-panel-close').click()
})

test('word-rule question: structured suggestion is a diff with «تطبيق»', async () => {
  await setDoc(SENTENCE, 6)
  await page.keyboard.press('Control+.')
  await expect(t('inspector')).toBeVisible()
  await t('gemini-ask').click()
  await expect(t('gemini-word-question')).toHaveValue('هل إعراب هذه الكلمة صحيح؟')
  await t('gemini-word-send').click()
  await expect(t('gemini-word-answer')).toContainText('الفاعل مرفوع')
  await expect(t('gemini-word-answer')).not.toContainText('mizaj-suggestion')
  await expect(t('gemini-diff')).toBeVisible()
  expect(gen().at(-1)!.body).toContain('الكلمة المقصودة')
  expect(await docText()).toBe(SENTENCE) // nothing edited yet
  await t('gemini-apply').click()
  expect(await docText()).toBe('ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ')
  await page.keyboard.press('Escape')
})

test('a suggestion that changes base letters is text only (no apply)', async () => {
  wordReply =
    'قد يكون الصواب غير ذلك.\n```mizaj-suggestion\nذَهَبَ الأَوْلَادُ إِلَى المَدْرَسَةِ\n```'
  await setDoc(SENTENCE, 6)
  await page.keyboard.press('Control+.')
  await expect(t('inspector')).toBeVisible()
  await t('gemini-ask').click()
  await t('gemini-word-send').click()
  await expect(t('gemini-diff')).toContainText('للاطلاع فقط')
  await expect(t('gemini-apply')).toHaveCount(0)
  expect(await docText()).toBe(SENTENCE)
  await page.keyboard.press('Escape')
})

test('long documents are sent whole; markdown renders; no suggestion for document questions', async () => {
  const memo = `${'فقرة من المذكرة القانونية. '.repeat(4000)}النهاية-الفريدة`
  await setDoc(memo, 0)
  override = () => ({
    json: {
      candidates: [
        {
          content: {
            parts: [
              { text: 'تفكير داخلي', thought: true },
              { text: '**الدفع الإجرائي:** نص\n\n1. أول\n2. ثان\n' },
              { text: '<img src=x onerror=alert(1)>\n```mizaj-suggestion\nكَتَبَ\n```' }
            ]
          },
          finishReason: 'STOP'
        }
      ]
    }
  })
  await t('toggle-gemini-panel').click()
  await t('gemini-question').fill('لخّص المذكرة')
  await t('gemini-send').click()
  const ans = t('gemini-answer').last()
  await expect(ans.locator('strong')).toHaveText('الدفع الإجرائي:')
  await expect(ans.locator('li')).toHaveCount(2)
  await expect(ans).not.toContainText('**')
  await expect(ans).not.toContainText('تفكير داخلي')
  await expect(ans.locator('img')).toHaveCount(0)
  await expect(t('gemini-truncated')).toHaveCount(0)
  await expect(t('gemini-suggestion')).toHaveCount(0)
  expect(gen().at(-1)!.body).toContain('النهاية-الفريدة')
  expect(gen().at(-1)!.body).toContain('maxOutputTokens')
  override = null
})

test('answer cut at the output limit offers «متابعة» which continues it', async () => {
  let n = 0
  override = (body) => {
    n++
    // with per-document memory every request carries earlier model turns; only «متابعة» sends this
    const cont = body.includes('تابع الإجابة من حيث توقفت')
    return {
      json: {
        candidates: [
          {
            content: { parts: [{ text: cont ? ' وتتمة الإجابة.' : 'بداية الإجابة 2. **الدفع' }] },
            finishReason: cont ? 'STOP' : 'MAX_TOKENS'
          }
        ]
      }
    }
  }
  await t('gemini-question').fill('سؤال طويل')
  await t('gemini-send').click()
  await expect(t('gemini-cutoff')).toContainText('انقطعت الإجابة لطولها')
  await t('gemini-continue').click()
  await expect(t('gemini-cutoff')).toHaveCount(0)
  await expect(t('gemini-answer').last()).toContainText('وتتمة الإجابة')
  await expect(t('gemini-answer').last()).toContainText('بداية الإجابة')
  expect(n).toBe(2)
  override = null
})

test('streaming: «يفكّر…» with seconds, text appears live, «إيقاف» aborts cleanly and keeps the partial', async () => {
  await t('gemini-question').fill('لخّص هذا المستند الطويل')
  hold = { firstDelayMs: 2500, first: 'بداية الملخص', released: false }
  await t('gemini-send').click()
  await expect(t('gemini-thinking')).toContainText('يفكّر')
  await expect(t('gemini-thinking')).toContainText(/\d+ ث/)
  await expect(t('gemini-stop')).toBeVisible()
  await expect(t('gemini-send')).toBeDisabled()
  // the first token arrives while the request is still open: it is shown at once
  await expect(t('gemini-answer').last()).toContainText('بداية الملخص')
  await expect(t('gemini-thinking')).toHaveCount(0)
  await expect(t('gemini-stop')).toBeVisible()
  await t('gemini-stop').click()
  await expect(t('gemini-stop')).toHaveCount(0)
  await expect(t('gemini-stopped')).toBeVisible()
  await expect(t('gemini-answer').last()).toContainText('بداية الملخص') // partial kept
  await expect.poll(() => holdClosed).toBe(true) // the HTTP request really was dropped
  await expect(t('gemini-error')).toHaveCount(0)
  // the panel is usable again
  await t('gemini-question').fill('سؤال بعد الإيقاف')
  await t('gemini-send').click()
  await expect(t('gemini-answer').last()).toContainText('هذا جواب عن المستند')
})

test('streaming: stop before the first token shows a clear note and nothing breaks', async () => {
  await t('gemini-question').fill('سؤال بطيء')
  hold = { firstDelayMs: 5000, first: 'متأخر', released: true }
  await t('gemini-send').click()
  await expect(t('gemini-thinking')).toBeVisible()
  await t('gemini-stop').click()
  await expect(t('gemini-stopped').last()).toContainText('قبل وصول أي نص')
  await expect.poll(() => holdClosed).toBe(true)
  await expect(t('gemini-send')).toBeDisabled() // empty question box, but not busy:
  await t('gemini-question').fill('x')
  await expect(t('gemini-send')).toBeEnabled()
  await t('gemini-question').fill('')
})

test('safety / recitation finish reasons give clear Arabic messages', async () => {
  override = () => ({ json: { candidates: [{ finishReason: 'RECITATION' }] } })
  await t('gemini-question').fill('سؤال')
  await t('gemini-send').click()
  await expect(t('gemini-error').last()).toContainText('نصاً محمياً')
  override = () => ({ json: { promptFeedback: { blockReason: 'SAFETY' } } })
  await t('gemini-question').fill('سؤال')
  await t('gemini-send').click()
  await expect(t('gemini-error').last()).toContainText('السلامة')
  override = null
})

test('quota with a short RetryInfo delay counts down and retries once; a long one explains', async () => {
  let n = 0
  const quota = (sec: string) => ({
    status: 429,
    json: {
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: sec }]
      }
    }
  })
  override = () => {
    n++
    return n === 1 ? quota('1s') : null
  }
  await t('gemini-question').fill('سؤال حصة')
  await t('gemini-send').click()
  await expect(t('gemini-countdown')).toContainText('ثانية')
  await expect(t('gemini-countdown')).toHaveCount(0, { timeout: 15000 })
  await expect.poll(() => n, { timeout: 15000 }).toBe(2)
  await expect(t('gemini-streaming')).toHaveCount(0, { timeout: 15000 })
  await expect(t('gemini-answer').last()).toContainText('هذا جواب عن المستند')
  override = () => quota('120s')
  await t('gemini-question').fill('سؤال حصة 2')
  await t('gemini-send').click()
  await expect(t('gemini-error').last()).toContainText('120')
  await expect(t('gemini-error').last()).toContainText('flash-lite')
  await expect(t('gemini-countdown')).toHaveCount(0)
  override = null
  await t('right-panel-close').click()
})

test('quota errors are shown in Arabic; clearing the key turns the assistant off', async () => {
  failStatus = 429
  await t('toggle-gemini-panel').click()
  await t('gemini-question').fill('سؤال')
  await t('gemini-send').click()
  await expect(t('gemini-error')).toContainText('حدّ الاستخدام')
  failStatus = null
  await t('right-panel-close').click()
  await t('open-settings').click()
  await t('settings-mode-advanced').click()
  await t('tab-online').click()
  await t('gemini-key-clear').click()
  await expect(t('gemini-message')).toContainText('حُذف المفتاح')
  await t('settings-close').click()
  await t('toggle-gemini-panel').click()
  await expect(t('gemini-panel-off')).toBeVisible() // no key = not ready
  await t('right-panel-close').click()
})

test.describe('resizable side panel', () => {
  const width = () => t('right-panel').evaluate((el) => el.getBoundingClientRect().width)
  const height = () => t('right-panel').evaluate((el) => el.getBoundingClientRect().height)

  test('drag the edge, clamp to min/max, remembered in settings', async () => {
    await t('toggle-spell-panel').click()
    await expect(t('right-panel')).toBeVisible()
    await expect(t('right-panel')).toContainText('قائمة الأخطاء الإملائية')
    const w0 = await width()
    const h = await t('panel-resize-handle').boundingBox()
    expect(h).not.toBeNull()
    const x = h!.x + h!.width / 2
    const y = h!.y + h!.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 100, y, { steps: 5 })
    await page.mouse.up()
    const w1 = await width()
    expect(w1).toBeGreaterThan(w0 + 50)
    await expect
      .poll(async () => (await api<Record<string, string>>('/api/settings')).panel_width)
      .toBe(String(Math.round(w1)))
    // far past the limits: clamped
    const h2 = (await t('panel-resize-handle').boundingBox())!
    await page.mouse.move(h2.x + 2, h2.y + 50)
    await page.mouse.down()
    await page.mouse.move(h2.x + 3000, h2.y + 50, { steps: 5 })
    await page.mouse.up()
    expect(await width()).toBeLessThanOrEqual(720)
    const h3 = (await t('panel-resize-handle').boundingBox())!
    await page.mouse.move(h3.x + 2, h3.y + 50)
    await page.mouse.down()
    await page.mouse.move(0, h3.y + 50, { steps: 5 })
    await page.mouse.up()
    expect(await width()).toBeGreaterThanOrEqual(240)
  })

  test('keyboard: arrows resize, Home/End jump to the limits', async () => {
    await t('panel-resize-handle').focus()
    await expect(t('panel-resize-handle')).toHaveAttribute('role', 'separator')
    await page.keyboard.press('End')
    await expect.poll(width).toBeGreaterThanOrEqual(600)
    await page.keyboard.press('Home')
    await expect.poll(width).toBeCloseTo(240, 0)
    const before = await width()
    await page.keyboard.press('ArrowRight') // grows toward the editor
    await expect.poll(width).toBeCloseTo(before + 16, 0)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(width).toBeCloseTo(before, 0)
    await expect
      .poll(async () => (await api<Record<string, string>>('/api/settings')).panel_width)
      .toBe('240')
  })

  test('collapse and expand', async () => {
    await t('panel-collapse-toggle').click()
    await expect(t('right-panel')).toHaveAttribute('data-collapsed', 'true')
    await expect.poll(width).toBeLessThan(60)
    await expect(t('panel-resize-handle')).toHaveCount(0)
    await t('panel-collapse-toggle').click()
    await expect.poll(width).toBeCloseTo(240, 0)
  })

  test('dock at the bottom: height resizes with the keyboard; setting persists', async () => {
    await t('panel-dock-toggle').click()
    await expect(t('right-panel')).toHaveAttribute('data-dock', 'bottom')
    await expect.poll(height).toBeGreaterThan(200)
    const before = await height()
    await t('panel-resize-handle').focus()
    await page.keyboard.press('ArrowUp')
    await expect.poll(height).toBeCloseTo(before + 16, 0)
    await expect
      .poll(async () => (await api<Record<string, string>>('/api/settings')).panel_dock)
      .toBe('bottom')
    await t('panel-dock-toggle').click()
    await expect(t('right-panel')).toHaveAttribute('data-dock', 'side')
    await t('right-panel-close').click()
    await t('toggle-spell-panel').click()
    await expect.poll(width).toBeCloseTo(240, 0) // remembered after closing and reopening
    await t('right-panel-close').click()
  })
})
