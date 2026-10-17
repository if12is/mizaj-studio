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
