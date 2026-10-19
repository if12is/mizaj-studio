import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Build of the Word add-in (task pane, ribbon commands, dialog) into out/word-addin/, served by the
 * Mizaj main process over https://localhost (src/main/wordaddin/server.ts). Run as part of
 * `electron-vite build` (see electron.vite.config.ts) or alone: `npx vite build -c word-addin/vite.config.ts`.
 * Relative base: the pages are served at the server root and never from a CDN.
 */
const here = __dirname

function copyManifestTemplate(): Plugin {
  return {
    name: 'mizaj-copy-manifest-template',
    closeBundle() {
      const out = resolve(here, '../out/word-addin')
      mkdirSync(out, { recursive: true })
      copyFileSync(resolve(here, 'manifest.template.xml'), resolve(out, 'manifest.template.xml'))
    }
  }
}

export default defineConfig({
  root: here,
  base: './',
  publicDir: resolve(here, 'public'),
  plugins: [copyManifestTemplate()],
  build: {
    outDir: resolve(here, '../out/word-addin'),
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      input: {
        taskpane: resolve(here, 'taskpane.html'),
        commands: resolve(here, 'commands.html'),
        message: resolve(here, 'message.html')
      }
    }
  }
})
