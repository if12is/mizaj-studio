export type SaveState = 'saved' | 'saving' | 'unsaved'

export interface AutosaveOptions {
  delayMs?: number
  getText: () => string
  save: (docId: number, text: string) => Promise<void>
  onState?: (s: SaveState) => void
}

/**
 * Debounced autosave. The document text stays in CodeMirror; it is only read
 * (getText) at flush time. markDirty() restarts the debounce, flush() saves now.
 */
export function createAutosave(o: AutosaveOptions) {
  const delay = o.delayMs ?? 5000
  let timer: ReturnType<typeof setTimeout> | null = null
  let docId: number | null = null
  let dirty = false
  let version = 0
  let chain: Promise<void> = Promise.resolve()

  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function setDocument(id: number | null): void {
    clear()
    docId = id
    dirty = false
    o.onState?.('saved')
  }

  function markDirty(): void {
    if (docId === null) return
    dirty = true
    version++
    o.onState?.('unsaved')
    clear()
    timer = setTimeout(() => void flush(), delay)
  }

  function flush(): Promise<void> {
    clear()
    chain = chain.then(async () => {
      if (!dirty || docId === null) return
      const id = docId
      const v = version
      const text = o.getText()
      o.onState?.('saving')
      try {
        await o.save(id, text)
        if (id === docId && v === version) {
          dirty = false
          o.onState?.('saved')
        } else if (id === docId) {
          o.onState?.('unsaved')
        }
      } catch {
        o.onState?.('unsaved')
      }
    })
    return chain
  }

  return { setDocument, markDirty, flush, isDirty: () => dirty, dispose: clear }
}

export type Autosave = ReturnType<typeof createAutosave>
