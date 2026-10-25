import { failCode } from './align'
import type { ApplyReport } from './apply'

/** Diagnostics the owner can copy: counts and code points only, NEVER document text. */
export interface Diagnostics {
  v: 1
  kind: 'map' | 'verify' | 'server'
  op: string
  codes: string[]
  failures?: ApplyReport['failures']
}

export function diagnosticsFromReport(op: string, r: ApplyReport): Diagnostics | null {
  if (r.failures.length)
    return {
      v: 1,
      kind: 'map',
      op,
      codes: r.failures.slice(0, 5).map(failCode),
      failures: r.failures.slice(0, 5)
    }
  if (r.verifyFailed) return { v: 1, kind: 'verify', op, codes: r.verifyCodes.slice(0, 5) }
  return null
}

export function diagnosticsFromMessage(op: string, messageAr: string): Diagnostics | null {
  const i = messageAr.indexOf('رمز:')
  if (i < 0) return null
  return { v: 1, kind: 'server', op, codes: [messageAr.slice(i + 4).trim()] }
}

export const diagJson = (d: Diagnostics): string => JSON.stringify(d, null, 1)

/** Compact JSON for a URL (the ribbon dialog), shrunk to fit. */
export function diagForUrl(d: Diagnostics, max = 1800): string {
  let j = JSON.stringify(d)
  if (j.length > max) j = JSON.stringify({ ...d, failures: undefined })
  return j.length > max ? j.slice(0, max) : j
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
