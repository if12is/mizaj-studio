import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1,
  // One retry on CI: a test that only passes on retry is reported as "flaky", not hidden.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  expect: { timeout: 15_000 }
})
