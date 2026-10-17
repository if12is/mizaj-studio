import { defineConfig } from '@playwright/test'

// Performance budgets (7.7.2). Run: npm run test:perf  (xvfb + built app + real sidecar, mock engine).
export default defineConfig({
  testDir: 'tests/perf',
  timeout: 300_000,
  workers: 1,
  retries: 0,
  reporter: [['list']]
})
