import { EditorView, type KeyBinding } from '@codemirror/view'
import { redo } from '@codemirror/commands'
import { stripMarks } from './arabic'
import { editsToSpec, stripEdits } from './markEdits'
import { closeInspector, openInspectorAt } from './inspector'

/** Strip diacritics of the selection (no-op when empty): one transaction. */
export function stripSelection(view: EditorView): boolean {
  const sel = view.state.selection.main
  if (sel.empty) return true
  const text = view.state.sliceDoc(sel.from, sel.to)
  const edits = stripEdits(text, sel.from)
  if (edits.length) view.dispatch(editsToSpec(view.state, edits, 'tashkeel.strip'))
  return true
}

/** Text to copy without diacritics: selection, or whole document if none. */
export function strippedClipboardText(view: EditorView): string {
  const sel = view.state.selection.main
  return stripMarks(sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to))
}

export function copyStripped(view: EditorView): boolean {
  void navigator.clipboard?.writeText(strippedClipboardText(view))
  return true
}

/**
 * Shortcuts. Electron's default application menu is removed in main
 * (Menu.setApplicationMenu(null) on win/linux) because its "Force Reload"
 * accelerator is Ctrl+Shift+R; Cmd+Shift+T/C and Ctrl+Space are unused.
 */
export function mizajKeymap(onDiacritize: () => void): KeyBinding[] {
  return [
    {
      key: 'Mod-Shift-t',
      preventDefault: true,
      run: () => {
        onDiacritize()
        return true
      }
    },
    { key: 'Mod-Shift-r', preventDefault: true, run: stripSelection },
    { key: 'Mod-Shift-c', preventDefault: true, run: copyStripped },
    { key: 'Ctrl-Space', preventDefault: true, run: (v) => openInspectorAt(v) },
    { key: 'Escape', run: closeInspector }
  ]
}

/**
 * Ctrl/Cmd+Shift+Z must redo. CodeMirror resolves a lowercase `key: "z"` with Shift
 * to the plain Mod-z (undo) binding, which happens with synthetic key events and some
 * layouts; real keyboards send "Z". Handle it explicitly.
 */
export const redoShiftZ = EditorView.domEventHandlers({
  keydown(e, view) {
    const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      redo(view)
      return true
    }
    return false
  }
})
