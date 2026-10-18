/** Thin wrappers over the preload API so renderer code never touches `window.mizajAPI` directly. */

export interface FilePick {
  extensions: string[]
  filterName?: string
}

export function pickSavePath(
  defaultName: string,
  extensions: string[],
  filterName?: string
): Promise<string | null> {
  const api = window.mizajAPI
  if (!api?.showSaveFileDialog) return Promise.resolve(null)
  return api.showSaveFileDialog({ defaultName, extensions, filterName })
}

export function pickOpenPath(extensions: string[], filterName?: string): Promise<string | null> {
  const api = window.mizajAPI
  if (!api?.showOpenFileDialog) return Promise.resolve(null)
  return api.showOpenFileDialog({ extensions, filterName })
}

export function pickDirectory(title?: string): Promise<string | null> {
  const api = window.mizajAPI
  if (!api?.showOpenDirectoryDialog) return Promise.resolve(null)
  return api.showOpenDirectoryDialog(title)
}

export async function openFolder(path: string): Promise<boolean> {
  const err = await window.mizajAPI?.openPath(path)
  return err === ''
}

/** Copies text to the clipboard; false when the OS/browser refuses (never claims success). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Opens an https link in the system browser (never inside the app). */
export function openExternal(url: string): void {
  void window.mizajAPI?.openExternal(url)
}
