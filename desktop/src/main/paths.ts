import { join } from 'node:path'

/**
 * Where user data lives. Priority: test override > portable build (next to the exe) > default.
 * Returns null to keep Electron's default userData.
 */
export function resolveUserDataDir(env: NodeJS.ProcessEnv): string | null {
  if (env.MIZAJ_USER_DATA_DIR) return env.MIZAJ_USER_DATA_DIR
  if (env.PORTABLE_EXECUTABLE_DIR) return join(env.PORTABLE_EXECUTABLE_DIR, 'MizajData')
  return null
}

/** electron-builder's portable target sets PORTABLE_EXECUTABLE_DIR for the running app. */
export const isPortable = (env: NodeJS.ProcessEnv): boolean => !!env.PORTABLE_EXECUTABLE_DIR
