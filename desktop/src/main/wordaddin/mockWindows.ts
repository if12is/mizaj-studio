import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Exec } from './install'

/**
 * An in-memory stand-in for reg.exe / certutil.exe, used ONLY by the Playwright suite on Linux
 * (MIZAJ_E2E_WORDADDIN_MOCK=1, honoured only by an unpackaged build). It mirrors the exit codes the
 * real tools give for the calls install.ts makes.
 */
export class MockWindows {
  readonly registry = new Map<string, string>()
  readonly roots = new Set<string>()
  /** simulate the user pressing «No» in the Windows certificate prompt */
  declineTrust = false

  readonly exec: Exec = async (file, args) => {
    if (file === 'reg.exe') {
      if (args[0] === 'add') {
        this.registry.set(args[3], args[7])
        return { code: 0, stdout: '' }
      }
      if (args[0] === 'delete') return { code: this.registry.delete(args[3]) ? 0 : 1, stdout: '' }
      if (args[0] === 'query') {
        if (/\\Word$/.test(args[1]) || args[1].includes('EdgeUpdate'))
          return { code: 0, stdout: '' }
        const v = this.registry.get(args[3])
        return v
          ? { code: 0, stdout: `\r\nHKEY_CURRENT_USER\\x\r\n    ${args[3]}    REG_SZ    ${v}\r\n` }
          : { code: 1, stdout: '' }
      }
    }
    if (file === 'certutil.exe') {
      if (args[1] === '-addstore') {
        if (this.declineTrust) return { code: 1, stdout: '' }
        const pem = readFileSync(args[3], 'utf8')
        const der = Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64')
        this.roots.add(createHash('sha1').update(der).digest('hex').toUpperCase())
        return { code: 0, stdout: '' }
      }
      if (args[1] === '-store')
        return { code: this.roots.has(args[3].toUpperCase()) ? 0 : 1, stdout: '' }
      if (args[1] === '-delstore')
        return { code: this.roots.delete(args[3].toUpperCase()) ? 0 : 1, stdout: '' }
    }
    return { code: 1, stdout: '' }
  }
}
