import { contextBridge, ipcRenderer } from 'electron'

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
  windowClose: (): Promise<void> => ipcRenderer.invoke('window:close'),
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
