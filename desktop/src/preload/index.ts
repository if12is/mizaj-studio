import { contextBridge, ipcRenderer, webUtils } from 'electron'

interface UpdaterStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'retrying'
    | 'error'
  version?: string
  percent?: number
  bytesPerSecond?: number
  message?: string
  code?: 'not-packaged' | 'portable'
  phase?: 'check' | 'download'
  attempt?: number
  maxAttempts?: number
  nextRetryAt?: number | null
  offline?: boolean
}

interface SidecarStatus {
  state: 'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped'
  port: number | null
  retry: number
  message?: string
}

// Sandboxed preload: only `electron` is require()d (contextBridge, ipcRenderer, webUtils).
const mizajAPI = {
  getBackendConfig: (): Promise<{
    port: number | null
    baseUrl: string | null
    status: SidecarStatus
    /** per-launch API token: send as `X-Mizaj-Token` on every backend request */
    token: string
  }> => ipcRenderer.invoke('backend:get-config'),
  onSidecarStatus: (cb: (s: SidecarStatus) => void): (() => void) => {
    const handler = (_e: unknown, s: SidecarStatus): void => cb(s)
    ipcRenderer.on('sidecar:status-changed', handler)
    return () => ipcRenderer.removeListener('sidecar:status-changed', handler)
  },
  getFlags: (): Promise<{ autoTour: boolean; toolbarAll: boolean }> => ipcRenderer.invoke('app:flags'),
  printSheets: (req: {
    html: string
    widthPt: number
    heightPt: number
    pages: number
    mode: 'print' | 'pdf'
    targetPath?: string
  }): Promise<{ ok: true; pages: number } | { ok: false; error: string }> =>
    ipcRenderer.invoke('print:run', req),
  windowMinimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  openGuide: (page: 'quick' | 'guide', anchor?: string): Promise<boolean> =>
    ipcRenderer.invoke('guide:open', page, anchor),
  windowToggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  getUpdaterStatus: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updater:get-status'),
  checkForUpdates: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updater:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('updater:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('updater:install'),
  setAutoUpdateCheck: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('updater:set-auto-check', enabled),
  onUpdaterStatus: (cb: (s: UpdaterStatus) => void): (() => void) => {
    const handler = (_e: unknown, s: UpdaterStatus): void => cb(s)
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },
  exportDiagnostics: (): Promise<string | null> => ipcRenderer.invoke('diagnostics:export'),
  getAboutInfo: (): Promise<{
    version: string
    electron: string
    license: string
    portable: boolean
    licenses: string | null
  }> => ipcRenderer.invoke('about:info'),
  showOpenPackDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:open-pack'),
  showSaveDialog: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:save-docx', defaultName),
  windowClose: (): Promise<void> => ipcRenderer.invoke('window:close'),
  showSaveFileDialog: (o: {
    defaultName: string
    extensions: string[]
    filterName?: string
  }): Promise<string | null> => ipcRenderer.invoke('dialog:save-file', o),
  showOpenFileDialog: (o: { extensions: string[]; filterName?: string }): Promise<string | null> =>
    ipcRenderer.invoke('dialog:open-file', o),
  showOpenDirectoryDialog: (title?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:open-directory', title),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:open-path', p),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url),
  relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
  gemini: {
    getState: (): Promise<unknown> => ipcRenderer.invoke('gemini:get-state'),
    setConfig: (patch: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('gemini:set-config', patch),
    acceptConsent: (): Promise<unknown> => ipcRenderer.invoke('gemini:accept-consent'),
    saveKey: (key: string): Promise<unknown> => ipcRenderer.invoke('gemini:save-key', key),
    clearKey: (): Promise<unknown> => ipcRenderer.invoke('gemini:clear-key'),
    testKey: (key?: string): Promise<unknown> => ipcRenderer.invoke('gemini:test-key', key),
    models: (): Promise<unknown> => ipcRenderer.invoke('gemini:models'),
    sessionGet: (docId: number, text: string): Promise<unknown> =>
      ipcRenderer.invoke('gemini:session-get', docId, text),
    sessionReset: (docId: number): Promise<unknown> =>
      ipcRenderer.invoke('gemini:session-reset', docId),
    ask: (req: unknown, streamId?: string): Promise<unknown> =>
      ipcRenderer.invoke('gemini:ask', req, streamId),
    cancel: (streamId: string): Promise<void> => ipcRenderer.invoke('gemini:cancel', streamId),
    onChunk: (cb: (m: { id: string; delta: string }) => void): (() => void) => {
      const handler = (_e: unknown, m: { id: string; delta: string }): void => cb(m)
      ipcRenderer.on('gemini:chunk', handler)
      return () => ipcRenderer.removeListener('gemini:chunk', handler)
    }
  },
  // «مِزَاج في أي برنامج»: settings page and the floating popup (main validates every call)
  systemwide: {
    getState: (): Promise<unknown> => ipcRenderer.invoke('systemwide:get-state'),
    setConfig: (patch: unknown): Promise<unknown> =>
      ipcRenderer.invoke('systemwide:set-config', patch),
    popupReady: (): Promise<unknown> => ipcRenderer.invoke('systemwide:popup-ready'),
    popupRun: (op: string): Promise<void> => ipcRenderer.invoke('systemwide:popup-run', op),
    popupApply: (): Promise<void> => ipcRenderer.invoke('systemwide:popup-apply'),
    popupCancel: (): Promise<void> => ipcRenderer.invoke('systemwide:popup-cancel'),
    popupResize: (height: number): Promise<void> =>
      ipcRenderer.invoke('systemwide:popup-resize', height),
    onPopupState: (cb: (s: unknown) => void): (() => void) => {
      const handler = (_e: unknown, s: unknown): void => cb(s)
      ipcRenderer.on('systemwide:popup-state', handler)
      return () => ipcRenderer.removeListener('systemwide:popup-state', handler)
    }
  },
  // Word add-in (settings page only; main validates every call)
  wordAddin: {
    getState: (): Promise<unknown> => ipcRenderer.invoke('wordaddin:get-state'),
    setEnabled: (v: boolean): Promise<unknown> => ipcRenderer.invoke('wordaddin:set-enabled', v),
    install: (): Promise<unknown> => ipcRenderer.invoke('wordaddin:install'),
    uninstall: (): Promise<unknown> => ipcRenderer.invoke('wordaddin:uninstall'),
    test: (): Promise<unknown> => ipcRenderer.invoke('wordaddin:test'),
    openCatalog: (): Promise<string> => ipcRenderer.invoke('wordaddin:open-catalog')
  },
  onBeforeQuitFlush: (cb: () => Promise<void>): (() => void) => {
    const handler = async (): Promise<void> => {
      try {
        await cb()
      } finally {
        ipcRenderer.send('app:flush-done')
      }
    }
    ipcRenderer.on('app:flush-request', handler)
    return () => ipcRenderer.removeListener('app:flush-request', handler)
  }
}

contextBridge.exposeInMainWorld('mizajAPI', mizajAPI)
