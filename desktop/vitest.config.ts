import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'] }
})
