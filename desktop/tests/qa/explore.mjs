// Exploratory QA sweep: opens every Settings section, changes EVERY control, restarts the app and
// verifies it persisted/applied; exercises the Quran install flows, the online switches and
// resources catalog; optionally imports QA_DOC and runs every toolbar button, collecting
// console errors, 4xx/5xx and raw/English toasts into $QA_OUT/findings.log plus screenshots.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOC, OUT, checkToast, has, launch, note, shot, t } from './lib.mjs'

const ud = mkdtempSync(join(tmpdir(), 'mizaj-qa-set-'))
let { app, page } = await launch({}, ud)

async function readControls() {
  const out = {}
  for (const tab of ['tab-general', 'tab-editor-quality']) {
    await t(page, tab).click()
    await page.waitForTimeout(400)
    for (const c of await page.locator('[data-testid^=setting-]').all()) {
      const id = await c.getAttribute('data-testid')
      const type = await c.getAttribute('type')
      out[id] = type === 'checkbox' ? await c.isChecked() : await c.inputValue()
    }
  }
  return out
}

await t(page, 'open-settings').click()
const tabs = await page
  .locator('[data-testid^=tab-]')
  .evaluateAll((e) => e.map((x) => x.dataset.testid))
for (const tab of tabs) {
  await t(page, tab).click()
  await page.waitForTimeout(600)
  await shot(page, 'settings-' + tab)
  await checkToast(page, tab)
}

// change every general / editor-quality control to a different value
const changed = {}
for (const tab of ['tab-general', 'tab-editor-quality']) {
  await t(page, tab).click()
  await page.waitForTimeout(400)
  for (const c of await page.locator('[data-testid^=setting-]').all()) {
    const id = await c.getAttribute('data-testid')
    const type = await c.getAttribute('type')
    const tag = await c.evaluate((e) => e.tagName)
    if (type === 'checkbox') {
      if (await c.isDisabled()) continue
      await c.click()
      changed[id] = await c.isChecked()
    } else if (tag === 'SELECT') {
      const cur = await c.inputValue()
      const opts = await c
        .locator('option:not([disabled])')
        .evaluateAll((o) => o.map((x) => x.value))
      const next = opts.find((v) => v !== cur)
      if (next === undefined) continue
      await c.selectOption(next)
      changed[id] = next
    }
    await page.waitForTimeout(200)
  }
}
await app.close()
;({ app, page } = await launch({}, ud))
await t(page, 'open-settings').click()
const again = await readControls()
for (const k of Object.keys(changed))
  if (String(again[k]) !== String(changed[k]))
    note('BUG', `setting ${k} not persisted across restart: wanted ${changed[k]} got ${again[k]}`)

// online switches + resources catalog
await t(page, 'tab-online').click()
for (const sw of ['switch-online-resources', 'switch-online-languagetool'])
  await t(page, sw).check()
await page.waitForTimeout(500)
await t(page, 'tools-refresh').click()
await shot(page, 'online-all-on')

// Quran: online download (must give a clear Arabic message when the network is blocked)
await t(page, 'tab-quran').click()
await t(page, 'quran-accept').check()
await t(page, 'quran-download').click()
await t(page, 'quran-message').waitFor({ timeout: 120000 })
console.log('quran download ->', await t(page, 'quran-message').innerText())
await shot(page, 'quran-download')

if (DOC) {
  await t(page, 'settings-close').click()
  await t(page, 'new-project').click()
  await t(page, 'new-project-input').fill('QA')
  await t(page, 'new-project-input').press('Enter')
  await page.waitForTimeout(600)
  await page.evaluate((p) => {
    const f = new File([new Uint8Array([80, 75])], p.split('/').pop())
    Object.defineProperty(f, 'path', { value: p })
    const dt = new DataTransfer()
    dt.items.add(f)
    const ev = (n) => new DragEvent(n, { dataTransfer: dt, bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev('dragenter'))
    document.body.dispatchEvent(ev('drop'))
  }, DOC)
  await t(page, 'drop-stats').waitFor()
  await t(page, 'drop-open').click()
  await page.waitForTimeout(800)
  for (const id of [
    'toolbar-spell',
    'toggle-spell-panel',
    'toolbar-tashkeel',
    'toggle-diff',
    'toggle-stats',
    'toolbar-find',
    'toolbar-review',
    'toolbar-normalize',
    'poetry-toggle',
    'toggle-poetry-panel',
    'toggle-quality-panel',
    'toggle-legal-panel',
    'export-docx',
    'load-sample'
  ]) {
    try {
      await t(page, id).click({ timeout: 8000 })
      await page.waitForTimeout(700)
      await checkToast(page, id)
      await shot(page, 'toolbar-' + id)
      for (const close of ['normalize-close', 'find-close', 'review-exit'])
        if (await has(page, close))
          await t(page, close)
            .click()
            .catch(() => {})
    } catch (e) {
      note('STEP-FAIL', `${id}: ${String(e.message).split('\n')[0]}`)
    }
  }
}
console.log('findings + screenshots in', OUT)
await app.close()
