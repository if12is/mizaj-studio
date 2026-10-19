import { useEditorStore } from '@renderer/stores/editor'

/** Open a document and put the cursor on a search match (selecting it, scrolled to the middle). */
export async function openAtMatch(
  openDocument: (id: number) => void | Promise<void>,
  documentId: number,
  offset: number,
  length: number
): Promise<void> {
  await openDocument(documentId)
  useEditorStore().accessor?.jumpTo(offset, offset + Math.max(0, length))
}
