import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { handleSecure } from '../ipcGuard'
import { resolveBase } from './api'
import { defaultDeps } from './cli'
import { GeminiConfigStore } from './config'
import { GeminiKeyStore, type SafeStorageLike } from './keyStore'
import { GeminiService } from './service'

/**
 * safeStorage, except that the Linux `basic_text` fallback (a hard-coded password, no keyring) is
 * not real protection and is treated as unavailable. Tests (unpackaged only) may substitute a
 * reversible fake because CI has no keyring.
 */
function pickStorage(): SafeStorageLike {
  if (!app.isPackaged && process.env.MIZAJ_E2E_FAKE_SAFESTORAGE === '1') {
    return {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`E2E:${Buffer.from(s).toString('base64')}`),
      decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString()
    }
  }
  return {
    isEncryptionAvailable: () => {
      if (!safeStorage.isEncryptionAvailable()) return false
      const backend = (
        safeStorage as { getSelectedStorageBackend?: () => string }
      ).getSelectedStorageBackend?.()
      return backend !== 'basic_text'
    },
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b)
  }
}

/**
 * IPC for the Gemini assistant. All network/CLI work happens here in the main process; the renderer
 * only ever receives a masked key hint. The test-only base URL override is honoured only when
 * the app is not packaged.
 */
export function registerGemini(): GeminiService {
  const dir = app.getPath('userData')
  const svc = new GeminiService({
    keys: new GeminiKeyStore(join(dir, 'gemini-key.bin'), pickStorage()),
    config: new GeminiConfigStore(join(dir, 'gemini-config.json')),
    fetch: (...a) => fetch(...a),
    base: resolveBase(process.env, !app.isPackaged),
    cli: defaultDeps()
  })
  handleSecure('gemini:get-state', () => svc.getState())
  handleSecure('gemini:set-config', (_e, patch: unknown) => svc.setConfig(patch))
  handleSecure('gemini:accept-consent', () => svc.acceptConsent())
  handleSecure('gemini:save-key', (_e, key: unknown) => svc.saveKey(key))
  handleSecure('gemini:clear-key', () => svc.clearKey())
  handleSecure('gemini:test-key', (_e, key: unknown) => svc.testKey(key))
  handleSecure('gemini:models', () => svc.models())
  handleSecure('gemini:detect-cli', () => svc.redetectCli())
  handleSecure('gemini:ask', (_e, req: unknown) => svc.ask(req as never))
  return svc
}
