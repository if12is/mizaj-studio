import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@fixtures': resolve('../backend/tests/fixtures')
      }
    },
    plugins: [vue()],
    server: { fs: { allow: [resolve('.'), resolve('../backend/tests/fixtures')] } }
  }
})
