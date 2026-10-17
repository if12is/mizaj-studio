// Real auto-update test on Windows (used by .github/workflows/update-e2e.yml):
// launches an INSTALLED older Mizaj Studio, waits for the update banner, downloads the
// newer GitHub release and clicks "restart & install". The workflow then verifies the
// installed exe version changed.
//   node scripts/update-e2e.mjs <installed exe> <expected new version> <userData dir>
import { _electron as electron } from '@playwright/test'

const [, , exe, expected, userData] = process.argv
if (!exe || !expected || !userData) {
  console.error('usage: update-e2e.mjs <exe> <expected-version> <userData>')
  process.exit(2)
}
const log = (...a) => console.log(new Date().toISOString(), ...a)

const app = await electron.launch({
  executablePath: exe,
  env: { ...process.env, MIZAJ_USER_DATA_DIR: userData },
  timeout: 120_000
})
let closed = false
app.on('close', () => {
  closed = true
  log('app closed (installer should be running)')
})
const page = await app.firstWindow()
page.on('console', (m) => m.type() === 'error' && log('renderer error:', m.text()))

try {
  // Auto check fires ~10 s after start once the renderer pushed auto_update_check.
  const banner = page.getByTestId('update-banner')
  await banner.waitFor({ timeout: 180_000 })
  const text = await page.getByTestId('update-text').innerText()
  log('banner:', text)
  if (!text.includes(expected)) throw new Error(`banner shows "${text}", expected ${expected}`)

  await page.getByTestId('update-download').click()
  log('download started')
  const install = page.getByTestId('update-install')
  await install.waitFor({ timeout: 600_000 })
  log(
    'downloaded; percent =',
    await page
      .getByTestId('update-percent')
      .innerText()
      .catch(() => '?')
  )
  await install.click()
  log('clicked restart & install')

  const deadline = Date.now() + 120_000
  while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
  if (!closed) throw new Error('app did not quit for installation within 120 s')
  log('UPDATE FLOW OK')
  process.exit(0)
} catch (e) {
  log('FAILED:', e.message)
  console.log(`::error title=Update E2E::${String(e.message).replace(/\r?\n/g, '%0A')}`)
  await page.screenshot({ path: 'update-e2e-failure.png' }).catch(() => {})
  await app.close().catch(() => {})
  process.exit(1)
}
