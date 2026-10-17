import { EditorState, type Extension } from '@codemirror/state'

/**
 * State for a freshly loaded/switched document. Loading MUST replace the whole
 * EditorState (view.setState) so the undo history starts empty; dispatching a
 * changes transaction would make "load" undoable and let Ctrl+Z resurrect the
 * previous document's text.
 */
export function createDocumentState(doc: string, extensions: Extension): EditorState {
  return EditorState.create({ doc, extensions })
}
