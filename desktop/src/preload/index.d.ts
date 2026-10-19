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
      | 'retrying'
      | 'error'
    version?: string
    /** state 'available': plain-text release notes summary */
    notes?: string
    percent?: number
    bytesPerSecond?: number
    message?: string
    code?: 'not-packaged' | 'portable'
    /** state 'retrying' (network trouble): what is retried and when */
    phase?: 'check' | 'download'
    attempt?: number
    maxAttempts?: number
    nextRetryAt?: number | null
    offline?: boolean
  }

  interface GeminiConfigDto {
    enabled: boolean
    model: string
    consentAt: string | null
  }
  interface GeminiStateDto {
    config: GeminiConfigDto
    hasKey: boolean
    keyHint: string | null
    encryptionAvailable: boolean
  }
  interface GeminiModelDto {
    id: string
    display: string
  }
  type GeminiOutcome<T> =
    | ({ ok: true } & T)
    | { ok: false; code: string; message: string; retryAfterSec?: number }
  interface GeminiAskResultDto {
    text: string
    suggestion: string | null
    truncated: boolean
    cutoff: boolean
    contextRefreshed: boolean
    context: 'explicit' | 'inline' | 'none'
  }
  interface GeminiSessionDto {
    messages: { q: string; scope: 'doc' | 'selection'; answer: string }[]
    stale: boolean
  }
  interface GeminiBridge {
    getState(): Promise<GeminiStateDto>
    setConfig(patch: Partial<Omit<GeminiConfigDto, 'consentAt'>>): Promise<GeminiStateDto>
    acceptConsent(): Promise<GeminiStateDto>
    saveKey(key: string): Promise<GeminiOutcome<{ state: GeminiStateDto }>>
    clearKey(): Promise<GeminiStateDto>
    testKey(
      key?: string
    ): Promise<GeminiOutcome<{ models: GeminiModelDto[]; defaultModel: string }>>
    models(): Promise<
      GeminiOutcome<{ models: GeminiModelDto[]; defaultModel: string; source: 'live' | 'fallback' }>
    >
    sessionGet(docId: number, text: string): Promise<GeminiOutcome<{ session: GeminiSessionDto }>>
    sessionReset(docId: number): Promise<GeminiOutcome<object>>
    ask(
      req:
        | {
            kind: 'document'
            question: string
            text: string
            docId?: number
            continueFrom?: string
          }
        | { kind: 'word'; question: string; word: string; sentence: string; continueFrom?: string }
        | {
            kind: 'selection'
            question: string
            text: string
            context?: string
            docId?: number
            docText?: string
            continueFrom?: string
          }
    ): Promise<GeminiOutcome<{ result: GeminiAskResultDto }>>
  }

  interface MizajAPI {
    getBackendConfig(): Promise<{
      port: number | null
      baseUrl: string | null
      status: SidecarStatus
      token: string
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
    openGuide(page: 'quick' | 'guide', anchor?: string): Promise<boolean>
    relaunchApp(): Promise<void>
    gemini: GeminiBridge
    onBeforeQuitFlush(cb: () => Promise<void>): () => void
  }

  interface Window {
    mizajAPI?: MizajAPI
  }
}
