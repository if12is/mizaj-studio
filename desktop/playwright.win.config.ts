import { defineConfig } from '@playwright/test'

// Installed-app E2E on Windows (real engine); see .github/workflows/windows-e2e.yml
export default defineConfig({
  testDir: 'tests/win-e2e',
  timeout: 300_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  expect: { timeout: 30_000 }
})
