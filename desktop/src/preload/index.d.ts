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
    /** abort when no data arrives for this many seconds (no total cap) */
    idleTimeoutSec: number
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
  interface GeminiUsageDto {
    promptTokens: number
    outputTokens: number
    thoughtsTokens: number
    cachedTokens: number
    totalTokens: number
  }
  interface GeminiKeyCheckDto {
    ok: boolean
    message?: string
    code?: string
    models?: GeminiModelDto[]
    defaultModel?: string
  }
  interface GeminiAskResultDto {
    usage: GeminiUsageDto
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
    saveKey(
      key: string
    ): Promise<GeminiOutcome<{ state: GeminiStateDto; check: GeminiKeyCheckDto }>>
    clearKey(): Promise<GeminiStateDto>
    testKey(
      key?: string
    ): Promise<GeminiOutcome<{ models: GeminiModelDto[]; defaultModel: string }>>
    models(): Promise<
      GeminiOutcome<{ models: GeminiModelDto[]; defaultModel: string; source: 'live' | 'fallback' }>
    >
    sessionGet(docId: number, text: string): Promise<GeminiOutcome<{ session: GeminiSessionDto }>>
    sessionReset(docId: number): Promise<GeminiOutcome<object>>
    cancel(streamId: string): Promise<void>
    onChunk(cb: (m: { id: string; delta: string }) => void): () => void
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
          },
      streamId?: string
    ): Promise<GeminiOutcome<{ result: GeminiAskResultDto }>>
  }

  type SystemwideShortcutId = 'main' | 'proofread' | 'punctuation' | 'tashkeel' | 'all'
  type SystemwideOpId = 'proofread' | 'punctuation' | 'tashkeel' | 'all'
  interface SystemwideConfigDto {
    enabled: boolean
    runInBackground: boolean
    replaceMode: 'preview' | 'direct'
    shortcuts: Record<SystemwideShortcutId, string>
  }
  interface SystemwideStateDto {
    supported: boolean
    platform: string
    config: SystemwideConfigDto
    shortcuts: Record<
      SystemwideShortcutId,
      { state: 'off' | 'registered' | 'conflict' | 'invalid'; accelerator: string; message: string }
    >
    errors: Record<string, string>
  }
  interface SystemwidePopupState {
    phase: 'choose' | 'running' | 'preview' | 'applying' | 'error'
    op: SystemwideOpId | null
    source: 'word' | 'html' | 'plain'
    chars: number
    snippet: string
    segments: { kind: 'same' | 'change'; text: string; old?: string; letters?: boolean }[]
    changed: boolean
    warnings: string[]
    error: string | null
    mode: 'preview' | 'direct'
  }
  interface SystemwideBridge {
    getState(): Promise<SystemwideStateDto>
    setConfig(patch: {
      enabled?: boolean
      runInBackground?: boolean
      replaceMode?: 'preview' | 'direct'
      shortcuts?: Partial<Record<SystemwideShortcutId, string>>
    }): Promise<SystemwideStateDto>
    popupReady(): Promise<SystemwidePopupState | null>
    popupRun(op: SystemwideOpId): Promise<void>
    popupApply(): Promise<void>
    popupCancel(): Promise<void>
    popupResize(height: number): Promise<void>
    onPopupState(cb: (s: SystemwidePopupState) => void): () => void
  }

  interface WordAddinState {
    supported: boolean
    enabled: boolean
    installed: boolean
    running: boolean
    port: number
    cert: {
      exists: boolean
      thumbprint: string | null
      notAfter: string | null
      trusted: boolean | null
      needsRenewal: boolean
      expired: boolean
    }
    manifestPath: string | null
    catalogDir: string
    officeJsLocal: boolean
    error: string | null
  }
  interface WordAddinStep {
    id: string
    ok: boolean
    text: string
  }
  interface WordAddinCheck {
    id: string
    level: 'ok' | 'warn' | 'fail'
    text: string
  }
  interface WordAddinBridge {
    getState(): Promise<WordAddinState>
    setEnabled(v: boolean): Promise<WordAddinState>
    install(): Promise<{ ok: boolean; steps: WordAddinStep[]; state: WordAddinState }>
    uninstall(): Promise<{ ok: boolean; steps: WordAddinStep[]; state: WordAddinState }>
    test(): Promise<{
      ok: boolean
      checks: WordAddinCheck[]
      roundTrip: { https: boolean; paired: boolean; engine: boolean }
    }>
    openCatalog(): Promise<string>
  }

  interface MizajAPI {
    getBackendConfig(): Promise<{
      port: number | null
      baseUrl: string | null
      status: SidecarStatus
      token: string
    }>
    onSidecarStatus(cb: (s: SidecarStatus) => void): () => void
    getFlags(): Promise<{ autoTour: boolean; toolbarAll: boolean }>
    printSheets(req: {
      html: string
      widthPt: number
      heightPt: number
      pages: number
      mode: 'print' | 'pdf'
      targetPath?: string
    }): Promise<{ ok: true; pages: number } | { ok: false; error: string }>
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
    systemwide: SystemwideBridge
    wordAddin: WordAddinBridge
    onBeforeQuitFlush(cb: () => Promise<void>): () => void
  }

  interface Window {
    mizajAPI?: MizajAPI
  }
}
