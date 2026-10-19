import { createApi, type Api } from './api'
import { Runner } from './run'
import type { WordHost } from './types'

/**
 * Shared start-up of the task pane and the ribbon commands page: pairing token from the URL,
 * Office.js loading (local copy first, Microsoft's CDN otherwise), service worker.
 */

type OfficeGlobal = {
  onReady(cb?: (i: { host?: string }) => void): Promise<{ host?: string }>
  context?: { requirements?: { isSetSupported(name: string, v: string): boolean } }
  actions?: { associate(name: string, fn: (e: { completed(): void }) => unknown): void }
}
declare global {
  interface Window {
    Office?: OfficeGlobal
    Word?: WordHost
  }
}

export const CDN_OFFICE_JS = 'https://appsforoffice.microsoft.com/lib/1/hosted/office.js'

/** The pairing token comes in the page URL (?k=) from the manifest; it is removed from the address bar. */
export function readPairing(loc: Location = location, hist: History = history): string | null {
  const k = new URLSearchParams(loc.search).get('k')
  try {
    if (k) hist.replaceState(null, '', loc.pathname)
  } catch {
    /* ignore */
  }
  return k && /^[A-Za-z0-9_-]{32,128}$/.test(k) ? k : null
}

function loadScript(src: string): Promise<void> {
  return new Promise((ok, fail) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => ok()
    s.onerror = () => fail(new Error('script'))
    document.head.appendChild(s)
  })
}

export async function loadOffice(): Promise<OfficeGlobal> {
  if (!window.Office) {
    // 1. an optional local copy served by Mizaj (/vendor/office.js), 2. Microsoft's CDN
    try {
      await loadScript('./vendor/office.js')
    } catch {
      await loadScript(CDN_OFFICE_JS)
    }
  }
  const o = window.Office
  if (!o) throw new Error('office')
  await o.onReady()
  return o
}

export function registerServiceWorker(): void {
  // best effort: keeps the add-in pages (and Office.js once fetched) available while Mizaj is closed
  try {
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker.register('./sw.js').catch(() => undefined)
  } catch {
    /* not available in this WebView */
  }
}

export interface Boot {
  api: Api
  runner: Runner
  paired: boolean
}

export function createBoot(office: OfficeGlobal, token: string | null): Boot {
  const api = createApi({ origin: location.origin, token })
  const runner = new Runner({
    host: window.Word as WordHost,
    api,
    supported: () => office.context?.requirements?.isSetSupported('WordApi', '1.4') ?? false
  })
  return { api, runner, paired: token !== null }
}
