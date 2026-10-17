export {}

declare global {
  interface SidecarStatus {
    state: 'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped'
    port: number | null
    retry: number
    message?: string
  }

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

  interface MizajAPI {
    getBackendConfig(): Promise<{
      port: number | null
      baseUrl: string | null
      status: SidecarStatus
    }>
    onSidecarStatus(cb: (s: SidecarStatus) => void): () => void
    windowMinimize(): Promise<void>
    windowToggleMaximize(): Promise<void>
    windowClose(): Promise<void>
    getPathForFile(file: File): string
    showOpenPackDialog(): Promise<string | null>
    exportDiagnostics(): Promise<string | null>
    getAboutInfo(): Promise<{
      version: string
      electron: string
      license: string
      portable: boolean
      licenses: string | null
    }>
    getUpdaterStatus(): Promise<UpdaterStatus>
    checkForUpdates(): Promise<UpdaterStatus>
    downloadUpdate(): Promise<void>
    installUpdate(): Promise<void>
    setAutoUpdateCheck(enabled: boolean): Promise<void>
    onUpdaterStatus(cb: (s: UpdaterStatus) => void): () => void
    showSaveDialog(defaultName: string): Promise<string | null>
    showSaveFileDialog(o: {
      defaultName: string
      extensions: string[]
      filterName?: string
    }): Promise<string | null>
    showOpenFileDialog(o: { extensions: string[]; filterName?: string }): Promise<string | null>
    showOpenDirectoryDialog(title?: string): Promise<string | null>
    openPath(p: string): Promise<string>
    openExternal(url: string): Promise<boolean>
    relaunchApp(): Promise<void>
    onBeforeQuitFlush(cb: () => Promise<void>): () => void
  }

  interface Window {
    mizajAPI?: MizajAPI
  }
}
