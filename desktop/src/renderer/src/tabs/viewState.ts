import type { EditorState } from '@codemirror/state'

/**
 * Everything a tab keeps of its editor: the CodeMirror state (text, undo history, selection)
 * plus scroll position and view toggles (page view, diff).
 */
export interface TabViewState {
  state: EditorState
  scrollTop: number
  pageView: boolean
  pageZoom: number
  diffBase: string | null
  showDiff: boolean
}
