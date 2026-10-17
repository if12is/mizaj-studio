import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { history, undo, undoDepth } from '@codemirror/commands'
import {
  acceptSpec,
  addPending,
  clearPending,
  pendingField,
  removePending,
  type PendingItem
} from './pending'

const doc = 'كتب الولد\nذهب الرجل\nقرأ الطالب'
const mk = () =>
  EditorState.create({ doc, extensions: [pendingField, history()], selection: { anchor: 4 } })
const items = (): PendingItem[] => [
  { id: 1, from: 0, to: 9, original: 'كتب الولد', proposed: 'كَتَبَ الوَلَدُ' },
  { id: 2, from: 10, to: 19, original: 'ذهب الرجل', proposed: 'ذَهَبَ الرَّجُلُ' }
]

describe('pending tashkeel preview', () => {
  it('previewing changes nothing in the document or history', () => {
    const s = mk().update({ effects: addPending.of(items()) }).state
    expect(s.doc.toString()).toBe(doc)
    expect(s.field(pendingField)).toHaveLength(2)
    expect(undoDepth(s)).toBe(0)
  })
  it('accepting one paragraph is one history event and keeps the cursor on the same letter', () => {
    let s = mk().update({ effects: addPending.of(items()) }).state
    s = s.update(acceptSpec(s, [s.field(pendingField)[0]])!).state
    expect(s.doc.toString().split('\n')[0]).toBe('كَتَبَ الوَلَدُ')
    expect(s.doc.toString().split('\n')[1]).toBe('ذهب الرجل')
    expect(s.field(pendingField).map((i) => i.id)).toEqual([2])
    expect(undoDepth(s)).toBe(1)
    // cursor was after "كتب " (pos 4) -> still after the same letters
    expect(s.doc.sliceString(0, s.selection.main.anchor).replace(/[ً-ْ]/g, '')).toBe('كتب ')
    let st = s
    undo({ state: st, dispatch: (tr) => (st = st.update(tr).state) })
    expect(st.doc.toString()).toBe(doc)
  })
  it('accept all is a single transaction / undo step', () => {
    let s = mk().update({ effects: addPending.of(items()) }).state
    s = s.update(acceptSpec(s, s.field(pendingField))!).state
    expect(s.doc.toString()).toBe('كَتَبَ الوَلَدُ\nذَهَبَ الرَّجُلُ\nقرأ الطالب')
    expect(undoDepth(s)).toBe(1)
    expect(s.field(pendingField)).toHaveLength(0)
  })
  it('follows edits before the paragraph and is dropped when the paragraph itself is edited', () => {
    let s = mk().update({ effects: addPending.of(items()) }).state
    s = s.update({ changes: { from: 0, insert: 'س ' } }).state
    expect(s.field(pendingField).map((i) => i.from)).toEqual([2, 12])
    s = s.update({ changes: { from: 14, to: 15, insert: 'ك' } }).state // inside paragraph 2
    expect(s.field(pendingField).map((i) => i.id)).toEqual([1])
  })
  it('refuses to accept a stale proposal; reject / clear remove items', () => {
    const s = mk().update({ effects: addPending.of(items()) }).state
    expect(acceptSpec(s, [{ ...items()[0], original: 'نص آخر' }])).toBeNull()
    expect(s.update({ effects: removePending.of([1]) }).state.field(pendingField)).toHaveLength(1)
    expect(s.update({ effects: clearPending.of(null) }).state.field(pendingField)).toHaveLength(0)
  })
})
