/**
 * Per-launch backend token (8.1.1). Delivered once by the main process through
 * getBackendConfig(); held in memory only (never in localStorage / URLs / logs).
 */
export const TOKEN_HEADER = 'X-Mizaj-Token'

let current: string | null = null

export function setApiToken(t: string | null): void {
  current = typeof t === 'string' && t ? t : null
}

export function getApiToken(): string | null {
  return current
}

/** Headers for a backend request: caller headers plus the token (when one is known). */
export function withToken(
  headers: Record<string, string> | undefined,
  token: string | null = current
): Record<string, string> | undefined {
  if (!token) return headers
  return { ...(headers ?? {}), [TOKEN_HEADER]: token }
}

// The token/baseUrl come from the main process asynchronously (also after every renderer reload).
// Requests wait for that first load, and a 401 triggers one refresh + retry.
let pending: Promise<void> | null = null
let refresher: (() => Promise<void>) | null = null

export function setConfigLoader(load: () => Promise<void>): Promise<void> {
  refresher = load
  pending = load().catch(() => undefined)
  return pending
}

export function waitForConfig(): Promise<void> {
  return pending ?? Promise.resolve()
}

/** Re-fetch the config from main (token may have changed or been missed). */
export function refreshConfig(): Promise<void> {
  if (!refresher) return Promise.resolve()
  pending = refresher().catch(() => undefined)
  return pending
}
