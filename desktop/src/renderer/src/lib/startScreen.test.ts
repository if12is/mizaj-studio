import { beforeEach, describe, expect, it } from 'vitest'
import { relativeTimeAr } from './relativeTime'
import { highlightParts } from '@renderer/search/content'
import { buildEntries, searchEntries, type PaletteSources } from '@renderer/search/entries'

const NOW = Date.UTC(2026, 5, 1, 12)
describe('relativeTimeAr', () => {
  it('uses Arabic plural forms and Arabic-Indic digits', () => {
    expect(relativeTimeAr(NOW - 5_000, NOW)).toBe('الآن')
    expect(relativeTimeAr(NOW - 60_000, NOW)).toBe('منذ دقيقة')
    expect(relativeTimeAr(NOW - 2 * 60_000, NOW)).toBe('منذ دقيقتين')
    expect(relativeTimeAr(NOW - 5 * 60_000, NOW)).toBe('منذ ٥ دقائق')
    expect(relativeTimeAr(NOW - 2 * 3_600_000, NOW)).toBe('منذ ساعتين')
    expect(relativeTimeAr(NOW - 3 * 86_400_000, NOW)).toBe('منذ ٣ أيام')
    expect(relativeTimeAr(NOW - 12 * 86_400_000, NOW)).toBe('منذ أسبوع')
    expect(relativeTimeAr(NOW + 5000, NOW)).toBe('الآن')
  })
})

// a minimal localStorage so the recent-files module persists in node
const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0
} as Storage

describe('recent files', () => {
  beforeEach(() => mem.clear())
  it('orders newest first, keeps view positions and removes entries', async () => {
    const r = await import('./recentFiles')
    r._reloadRecentForTests()
    r.touchRecentFile({ documentId: 1, projectId: 1, title: 'أ' }, 1000)
    r.touchRecentFile({ documentId: 2, projectId: 1, title: 'ب' }, 2000)
    r.touchRecentFile({ documentId: 1, projectId: 1, title: 'أ' }, 3000)
    expect(r.recentFiles.value.map((f) => f.documentId)).toEqual([1, 2])
    r.setRecentSnippet(1, 'بسم الله')
    r.saveViewPos(1, { anchor: 42, scrollTop: 300.4 })
    r._reloadRecentForTests() // survives a reload
    expect(r.recentFiles.value[0].snippet).toBe('بسم الله')
    expect(r.getViewPos(1)).toEqual({ anchor: 42, scrollTop: 300 })
    r.removeRecentFile(1)
    expect(r.recentFiles.value.map((f) => f.documentId)).toEqual([2])
    expect(r.getViewPos(1)).toBeNull()
  })
  it('tolerates corrupt storage', async () => {
    mem.set('mizaj.recent.v1', '{nope')
    const r = await import('./recentFiles')
    r._reloadRecentForTests()
    expect(r.recentFiles.value).toEqual([])
  })
})

describe('content search helpers', () => {
  it('splits an excerpt into plain and highlighted parts', () => {
    expect(highlightParts('ذهب المَدْرَسَةِ اليوم', [[4, 16]])).toEqual([
      { text: 'ذهب ', mark: false },
      { text: 'المَدْرَسَةِ', mark: true },
      { text: ' اليوم', mark: false }
    ])
    expect(highlightParts('abc', [])).toEqual([{ text: 'abc', mark: false }])
  })
  it('palette: «في المحتوى» group carries the backend hits unfiltered', () => {
    const base: PaletteSources = {
      commands: [],
      settingsSections: [],
      projects: [],
      documents: {},
      recent: [],
      guide: [],
      openSettings: () => {},
      openProject: () => {},
      openDocument: () => {}
    }
    const opened: unknown[] = []
    const entries = buildEntries({
      ...base,
      content: [
        {
          documentId: 7,
          title: 'عقد',
          projectName: 'قضية',
          text: 'نص المدرسة',
          marks: [[3, 10]],
          offset: 12
        }
      ],
      openContent: (...a) => opened.push(a)
    })
    const groups = searchEntries(entries, 'مدرسه')
    const g = groups.find((x) => x.id === 'content')
    expect(g?.label).toBe('في المحتوى')
    expect(g?.items).toHaveLength(1)
    void g?.items[0].run()
    expect(opened).toEqual([[7, 12, 7]])
    expect(searchEntries(entries, '').some((x) => x.id === 'content')).toBe(false)
  })
})
