import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Forks, not worker threads: a test that spawns processes can leave a handle
    // that keeps a thread worker alive forever on CI ("Failed to terminate worker").
    pool: 'forks'
  }
})
