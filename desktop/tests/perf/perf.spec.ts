import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Performance budgets (7.7.2). Each metric is the MEDIAN of several runs; the budgets in
 * perf/budgets.json were set from measured numbers with generous headroom for slower CI
 * runners (see `headroom` there). Set PERF_REPORT=1 to print a fresh measurement table.
 */
const desktopDir = resolve(__dirname, '../..')
const budgets = JSON.parse(readFileSync(join(desktopDir, 'perf/budgets.json'), 'utf8')) as {
  headroom: string
  maxMs: Record<string, number>
  minRate: Record<string, number>
}
const sample = readFileSync(
  resolve(desktopDir, '../backend/tests/fixtures/sample_long.txt'),
  'utf8'
)
const words = (t: string) => (t.match(/\S+/g) ?? []).length
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

let app: ElectronApplication
let page: Page
let userData: string
const measured: Record<string, number> = {}

type CM = {
  cmView: {
    view: {
      state: { doc: { length: number } }
      scrollDOM: HTMLElement
      dispatch(s: unknown): void
    }
  }
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mizaj-perf-'))
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    cwd: desktopDir,
    env: { ...process.env, MIZAJ_ENGINE_MODE: 'mock', MIZAJ_USER_DATA_DIR: userData }
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('status-sidecar')).toContainText('المحرك: جاهز')
})
test.afterAll(async () => {
  if (process.env.PERF_REPORT) console.log('PERF', JSON.stringify(measured))
  writeFileSync(join(userData, 'perf.json'), JSON.stringify(measured))
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

/** time (ms) to replace the whole document and paint (two animation frames) */
const timed = (insert: string) =>
  page.evaluate(async (a) => {
    const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const t0 = performance.now()
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: a },
      selection: { anchor: 0 }
    })
    await raf()
    return performance.now() - t0
  }, insert)

const check = (name: string, kind: 'maxMs' | 'minRate', value: number) => {
  measured[name] = Math.round(value * 10) / 10
  if (kind === 'maxMs')
    expect(value, `${name} ${value}ms > budget ${budgets.maxMs[name]}ms`).toBeLessThanOrEqual(
      budgets.maxMs[name]
    )
  else
    expect(value, `${name} ${value} < budget ${budgets.minRate[name]}`).toBeGreaterThanOrEqual(
      budgets.minRate[name]
    )
}

test('load the 33k-word sample', async () => {
  const runs: number[] = []
  for (let i = 0; i < 3; i++) runs.push(await timed(sample))
  check('loadSampleMs', 'maxMs', median(runs))
})

test('typing latency in a very long single line', async () => {
  const single = sample.replace(/\s*\n\s*/g, ' ')
  await timed(single)
  const runs: number[] = []
  for (let i = 0; i < 5; i++) {
    runs.push(
      await page.evaluate(async (pos) => {
        const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
        const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const t0 = performance.now()
        v.dispatch({ changes: { from: pos, insert: 'ا' } })
        await raf()
        return performance.now() - t0
      }, 100_000 + i)
    )
  }
  check('typeLongLineMs', 'maxMs', median(runs))
})

test('scroll smoothness on the sample (frames per second)', async () => {
  await timed(sample)
  const runs: number[] = []
  for (let i = 0; i < 3; i++) {
    runs.push(
      await page.evaluate(async () => {
        const v = (document.querySelector('.cm-content') as unknown as CM).cmView.view
        const el = v.scrollDOM
        el.scrollTop = 0
        let frames = 0
        const t0 = performance.now()
        await new Promise<void>((resolve) => {
          const tick = (): void => {
            frames++
            el.scrollTop += 400
            if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
            else resolve()
          }
          requestAnimationFrame(tick)
        })
        return (frames / (performance.now() - t0)) * 1000
      })
    )
  }
  check('scrollFps', 'minRate', median(runs))
})

for (const mode of ['multi-line', 'single-line'] as const) {
  test(`tashkeel run on a ${mode} document: throughput and undo`, async () => {
    const body = mode === 'multi-line' ? sample : sample.replace(/\s*\n\s*/g, ' ').slice(0, 100_000)
    await timed(body)
    await page.waitForTimeout(300)
    const t0 = Date.now()
    await page.getByTestId('toolbar-tashkeel').click()
    await page.locator('[data-testid=progress-bar][data-state=done]').waitFor({ timeout: 200_000 })
    const secs = (Date.now() - t0) / 1000
    check(
      mode === 'multi-line' ? 'runWordsPerSec' : 'runSingleLineWordsPerSec',
      'minRate',
      words(body) / secs
    )
    await page.locator('.cm-content').click()
    const u0 = Date.now()
    await page.keyboard.press('Control+z')
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    )
    check(mode === 'multi-line' ? 'undoRunMs' : 'undoRunSingleLineMs', 'maxMs', Date.now() - u0)
    await page.locator('[data-testid=progress-bar]').waitFor({ state: 'detached', timeout: 10_000 })
  })
}
