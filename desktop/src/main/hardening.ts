import { app, type Session } from 'electron'
import {
  buildCsp,
  isAllowedExternalUrl,
  isAppUrl,
  isPermissionAllowed,
  type AppLocation
} from './security'

interface Log {
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
}

/**
 * Navigation / popup / webview lockdown for EVERY webContents (8.2.1).
 * Call once, before the first window is created.
 */
export function hardenWebContents(
  loc: AppLocation,
  log: Log,
  openExternal: (url: string) => void
): void {
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (e) => {
      e.preventDefault()
      log.warn('security: <webview> attach blocked')
    })
    const guard = (e: { preventDefault(): void }, url: string): void => {
      if (isAppUrl(url, loc)) return
      e.preventDefault()
      log.warn('security: navigation blocked', safeOrigin(url))
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) openExternal(url)
      else log.warn('security: window.open blocked', safeOrigin(url))
      return { action: 'deny' }
    })
  })
}

function safeOrigin(url: string): string {
  try {
    const u = new URL(url)
    return u.origin === 'null' ? u.protocol : u.origin
  } catch {
    return '<invalid url>'
  }
}

/** Deny every permission except clipboard writes, and send the strict CSP header with the app's own documents. */
export function hardenSession(ses: Session, loc: AppLocation, log: Log): void {
  ses.setSpellCheckerEnabled(false) // the app has its own Arabic spelling; nothing is sent to a spell-check service
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = isPermissionAllowed(permission, details?.requestingUrl ?? wc.getURL(), loc)
    if (!ok) log.info('security: permission denied', permission)
    cb(ok)
  })
  ses.setPermissionCheckHandler((_wc, permission, origin, details) =>
    isPermissionAllowed(permission, details?.requestingUrl ?? origin, loc)
  )
  ses.setDevicePermissionHandler(() => false)

  const csp = buildCsp({ dev: !!loc.rendererUrl })
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (!isAppUrl(details.url, loc)) return cb({ responseHeaders: details.responseHeaders })
    const headers: Record<string, string[] | string> = { ...details.responseHeaders }
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'content-security-policy') delete headers[k]
    }
    headers['Content-Security-Policy'] = [csp]
    cb({ responseHeaders: headers as Record<string, string[]> })
  })
}
