/**
 * The slice of the Word JavaScript API (WordApi 1.3 / 1.4) that the add-in uses, as structural
 * interfaces. The real `Word` global satisfies them; the fake Word of word-addin/test/fakeOffice.cjs
 * implements the same surface, which is what the unit and browser tests run against.
 * (No dependency on @types/office-js: only what is actually called is declared.)
 */
export type InsertLocation = 'Replace' | 'Start' | 'End' | 'Before' | 'After'

export interface WCollection<T> {
  items: T[]
  load(props?: string): WCollection<T>
}

export interface WRange {
  text: string
  load(props?: string): WRange
  getRange(location?: 'Whole' | 'Start' | 'End' | 'After' | 'Content'): WRange
  intersectWith(range: WRange): WRange
  search(
    text: string,
    options?: { matchWildcards?: boolean; matchCase?: boolean }
  ): WCollection<WRange>
  insertText(text: string, location: InsertLocation): WRange
  delete(): void
  paragraphs: WCollection<WParagraph>
}

export interface WParagraph {
  text: string
  tableNestingLevel: number
  load(props?: string): WParagraph
  getRange(location?: 'Whole' | 'Start' | 'End' | 'After' | 'Content'): WRange
  fields: WCollection<unknown>
  contentControls: WCollection<unknown>
}

export interface WContext {
  document: { getSelection(): WRange }
  sync(): Promise<void>
}

export interface WordHost {
  run<T>(batch: (context: WContext) => Promise<T>): Promise<T>
}
