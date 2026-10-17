import { contextBridge, ipcRenderer, webUtils } from 'electron'

interface UpdaterStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
  version?: string
  percent?: number
  bytesPerSecond?: number
  message?: string
  code?: 'not-packaged' | 'portable'
}

interface SidecarStatus {
  state: 'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped'
  port: number | null
  retry: number
  message?: string
}

const mizajAPI = {
  getBackendConfig: (): Promise<{
    port: number | null
    baseUrl: string | null
    status: SidecarStatus
  }> => ipcRenderer.invoke('backend:get-config'),
  onSidecarStatus: (cb: (s: SidecarStatus) => void): (() => void) => {
    const handler = (_e: unknown, s: SidecarStatus): void => cb(s)
    ipcRenderer.on('sidecar:status-changed', handler)
    return () => ipcRenderer.removeListener('sidecar:status-changed', handler)
  },
  windowMinimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
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
