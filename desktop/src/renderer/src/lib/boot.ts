import { ref } from 'vue'

/** Flipped once the editor view exists; the splash screen stays up until then. */
export const editorReady = ref(false)

export function markEditorReady(): void {
  if (editorReady.value) return
  performance.mark('mizaj:editor-ready')
  // The mark is the moment CodeMirror is mounted; reveal on the next frame so the first
  // editor paint happens under the splash's fade-out, not as a blank frame.
  requestAnimationFrame(() => {
    editorReady.value = true
    performance.mark('mizaj:splash-hidden')
  })
}
