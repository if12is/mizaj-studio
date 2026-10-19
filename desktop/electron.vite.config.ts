import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Preload only the fonts the first screen needs (UI Cairo 400/600 and the editor font Amiri 400),
 * injected into index.html at build time with their hashed names. Everything else
 * (Cairo 700, Amiri 700, the COLR font) loads on demand. No `crossorigin` attribute: the app is
 * loaded from file:// where a CORS-mode preload is never matched by the font request.
 */
function preloadCriticalFonts(): Plugin {
  const critical = [
    /cairo-arabic-400-normal.*\.woff2$/,
    /cairo-arabic-600-normal.*\.woff2$/,
    /amiri-arabic-400-normal.*\.woff2$/
  ]
  return {
    name: 'mizaj-preload-fonts',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html
        const links = Object.keys(ctx.bundle)
          .filter((f) => critical.some((r) => r.test(f)))
          .map((f) => `<link rel="preload" as="font" type="font/woff2" href="./${f}" />`)
          .join('\n    ')
        return html.replace('</head>', `  ${links}\n  </head>`)
      }
    }
  }
}

/** Dev only: Vite HMR needs ws/http to localhost. Never applied to the build output. */
function devCspForHmr(): Plugin {
  let serving = false
  return {
    name: 'mizaj-dev-csp',
    configResolved: (c) => {
      serving = c.command === 'serve'
    },
    transformIndexHtml: (html) =>
      serving
        ? html.replace(/connect-src ([^;"]*)/, 'connect-src $1 ws://localhost:* http://localhost:*')
        : html
  }
}

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
    plugins: [vue(), preloadCriticalFonts(), devCspForHmr()],
    build: {
      // 600 KB warning threshold: the entry must stay small, heavy features are lazy chunks
      chunkSizeWarningLimit: 600,
      // electron-vite leaves the renderer unminified by default; minify so the package is small
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: {
        // second page: the hidden print window (src/main/print.ts)
        input: {
          index: resolve('src/renderer/index.html'),
          print: resolve('src/renderer/print.html')
        },
        output: {
          // Vendor split keeps the entry chunk to app code. @codemirror/merge (diff view) is not
          // listed: it stays with its lazy DiffView chunk.
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('@codemirror/merge')) return undefined
            if (/node_modules\/(@codemirror|@lezer|crelt|style-mod|w3c-keyname)/.test(id))
              return 'codemirror'
            if (/node_modules\/(vue|@vue|pinia)\//.test(id)) return 'vue'
            return undefined
          }
        }
      }
    },
    server: { fs: { allow: [resolve('.'), resolve('../backend/tests/fixtures')] } }
  }
})
