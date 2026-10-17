import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Startup & size budgets (8.3.1). Cold-ish launches of the built app (mock engine); each time
 * metric is the MEDIAN of 3 launches. Set PERF_REPORT=1 to print the table.
 * Marks come from the renderer: first paint (Paint Timing) and `mizaj:editor-ready`.
 */
const desktopDir = resolve(__dirname, '../..')
const budgets = JSON.parse(readFileSync(join(desktopDir, 'perf/budgets.json'), 'utf8')) as {
  maxMs: Record<string, number>
  maxKB: Record<string, number>
  maxMB: Record<string, number>
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

const rendererDir = join(desktopDir, 'out/renderer')
const assets = join(rendererDir, 'assets')
function dirKB(dir: string): number {
  let total = 0
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    total += statSync(p).isDirectory() ? dirKB(p) : statSync(p).size / 1024
  }
  return total
}
function bundleSizes(): {
  entryKB: number
  criticalKB: number
  totalJsKB: number
  distKB: number
} {
  const html = readFileSync(join(rendererDir, 'index.html'), 'utf8')
  const kb = (f: string) => statSync(join(assets, f)).size / 1024
  const js = readdirSync(assets).filter((f) => f.endsWith('.js'))
  // what the HTML loads eagerly: the entry script + its modulepreload'ed vendor chunks
  const entry = /<script[^>]+src="[^"]*\/assets\/([^"]+\.js)"/.exec(html)?.[1] as string
  const eager = [...html.matchAll(/(?:src|href)="[^"]*\/assets\/([^"]+\.js)"/g)].map((m) => m[1])
  return {
    entryKB: kb(entry),
    criticalKB: eager.reduce((s, f) => s + kb(f), 0),
    totalJsKB: js.reduce((s, f) => s + kb(f), 0),
    distKB: dirKB(rendererDir)
  }
}

test('startup metrics and bundle sizes', async () => {
  test.setTimeout(240_000)
  const firstPaint: number[] = []
  const editorReady: number[] = []
  const idleHeap: number[] = []
  const idleRss: number[] = []
  let sampleHeap = 0
  let sampleRss = 0
  for (let i = 0; i < 3; i++) {
    const userData = mkdtempSync(join(tmpdir(), 'mizaj-start-'))
    const app = await electron.launch({
      args: ['.', '--no-sandbox', '--disable-gpu', '--enable-precise-memory-info'],
      cwd: desktopDir,
      env: { ...process.env, MIZAJ_ENGINE_MODE: 'mock', MIZAJ_USER_DATA_DIR: userData }
    })
    const page = await app.firstWindow()
    await expect(page.getByTestId('status-sidecar')).toContainText('المحرك: جاهز', {
      timeout: 60_000
    })
    await page.waitForTimeout(2500) // let deferred/idle work settle
    const m = await page.evaluate(() => ({
      fp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1,
      ready: performance.getEntriesByName('mizaj:editor-ready')[0]?.startTime ?? -1,
      heap: (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize
    }))
    firstPaint.push(m.fp)
    editorReady.push(m.ready)
    idleHeap.push(m.heap / 1048576)
    const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics())
    const tab = metrics.find((x) => x.type === 'Tab')
    idleRss.push((tab?.memory.workingSetSize ?? 0) / 1024)
    if (i === 2) {
      await page.getByTestId('load-sample').click()
      await page.waitForTimeout(1500)
      sampleHeap = await page.evaluate(
        () =>
          (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize /
          1048576
      )
      const after = await app.evaluate(({ app: a }) => a.getAppMetrics())
      sampleRss = (after.find((x) => x.type === 'Tab')?.memory.workingSetSize ?? 0) / 1024
    }
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
  const sizes = bundleSizes()
  const out = {
    firstPaintMs: Math.round(median(firstPaint)),
    editorReadyMs: Math.round(median(editorReady)),
    idleHeapMB: Math.round(median(idleHeap) * 10) / 10,
    idleTabRssMB: Math.round(median(idleRss) * 10) / 10,
    sampleLoadedHeapMB: Math.round(sampleHeap * 10) / 10,
    sampleLoadedTabRssMB: Math.round(sampleRss * 10) / 10,
    entryChunkKB: Math.round(sizes.entryKB),
    criticalJsKB: Math.round(sizes.criticalKB),
    totalJsKB: Math.round(sizes.totalJsKB),
    rendererDistKB: Math.round(sizes.distKB)
  }
  console.log('STARTUP', JSON.stringify(out))
  writeFileSync(join(tmpdir(), 'mizaj-startup.json'), JSON.stringify(out))
  expect(out.firstPaintMs, 'first paint').toBeGreaterThan(0)
  expect(out.firstPaintMs, 'first paint').toBeLessThanOrEqual(budgets.maxMs.firstPaintMs)
  expect(out.editorReadyMs, 'editor ready').toBeGreaterThan(0)
  expect(out.editorReadyMs, 'editor ready').toBeLessThanOrEqual(budgets.maxMs.editorReadyMs)
  expect(out.entryChunkKB, 'entry chunk').toBeLessThanOrEqual(budgets.maxKB.entryChunkKB)
  expect(out.criticalJsKB, 'critical js').toBeLessThanOrEqual(budgets.maxKB.criticalJsKB)
  expect(out.totalJsKB, 'total js').toBeLessThanOrEqual(budgets.maxKB.totalJsKB)
  expect(out.rendererDistKB, 'renderer dist').toBeLessThanOrEqual(budgets.maxKB.rendererDistKB)
  expect(out.sampleLoadedTabRssMB, 'tab rss after sample').toBeLessThanOrEqual(
    budgets.maxMB.sampleLoadedTabRssMB
  )
  expect(out.idleHeapMB, 'idle heap').toBeLessThanOrEqual(budgets.maxMB.idleHeapMB)
})
