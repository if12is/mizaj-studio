export {}

declare global {
  interface SidecarStatus {
    state: 'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped'
    port: number | null
    retry: number
    message?: string
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
    showSaveDialog(defaultName: string): Promise<string | null>
    onBeforeQuitFlush(cb: () => Promise<void>): () => void
  }

  interface Window {
    mizajAPI?: MizajAPI
  }
}
