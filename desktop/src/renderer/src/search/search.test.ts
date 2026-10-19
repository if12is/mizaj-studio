import { describe, expect, it } from 'vitest'
import { normalizeArabic } from './normalize'
import { bestScore, fuzzyScore } from './fuzzy'
import { buildEntries, flatten, searchEntries, type PaletteSources } from './entries'

describe('normalizeArabic', () => {
  it('strips diacritics and tatweel', () => {
    expect(normalizeArabic('مُحَمَّدٌ')).toBe('محمد')
    expect(normalizeArabic('كــتــاب')).toBe('كتاب')
    expect(normalizeArabic('الْقُرْآنِ')).toBe('القران')
  })
  it('folds alef variants, alef maqsura and ta marbuta', () => {
    expect(normalizeArabic('أحمد إبراهيم آدم')).toBe('احمد ابراهيم ادم')
    expect(normalizeArabic('مستشفى')).toBe('مستشفي')
    expect(normalizeArabic('مدرسة')).toBe('مدرسه')
  })
  it('lower-cases latin, maps arabic-indic digits and collapses spaces', () => {
    expect(normalizeArabic('  Export   DOCX ')).toBe('export docx')
    expect(normalizeArabic('صفحة ١٢٣')).toBe('صفحه 123')
  })
  it('is idempotent and leaves empty input alone', () => {
    const once = normalizeArabic('إِنَّ الأُمَّةَ')
    expect(normalizeArabic(once)).toBe(once)
    expect(normalizeArabic('')).toBe('')
  })
})

describe('fuzzyScore', () => {
  it('matches across hamza/ya/ta-marbuta variants and diacritics', () => {
    expect(fuzzyScore('اسئله', 'أَسْئِلَة')).not.toBeNull()
    expect(fuzzyScore('احمد', 'أَحْمَد')).not.toBeNull()
    expect(fuzzyScore('مدرسه', 'المدرسة')).not.toBeNull()
    expect(fuzzyScore('مستشفي', 'مستشفى')).not.toBeNull()
  })
  it('requires every token, in any order', () => {
    expect(fuzzyScore('docx تصدير', 'تصدير المستند الحالي: Word (DOCX)')).not.toBeNull()
    expect(fuzzyScore('docx xyz', 'تصدير DOCX')).toBeNull()
  })
  it('is typo tolerant for longer tokens via subsequence, but not for short ones', () => {
    expect(fuzzyScore('تشكل', 'تشكيل الفقرة')).not.toBeNull()
    expect(fuzzyScore('تك', 'تشكيل')).toBeNull()
  })
  it('ranks word-start and prefix matches above inner matches', () => {
    const a = fuzzyScore('بحث', 'بحث واستبدال') as number
    const b = fuzzyScore('بحث', 'أداة للبحث') as number
    expect(a).toBeGreaterThan(b)
  })
  it('empty query matches everything with score 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
    expect(bestScore('x', [undefined, undefined])).toBeNull()
  })
})

function sources(over: Partial<PaletteSources> = {}): PaletteSources {
  return {
    commands: [
      { id: 'tabs.new', title: 'تبويب جديد', shortcut: 'Ctrl+T', run: () => {} },
      { id: 'edit.tashkeel', title: 'تشكيل المحدد', run: () => {} },
      { id: 'x.hidden', title: 'مخفي', hidden: true, run: () => {} },
      { id: 'x.off', title: 'معطل', enabled: () => false, run: () => {} }
    ],
    settingsSections: [
      { id: 'general', label: 'عام' },
      { id: 'quran', label: 'القرآن الكريم' }
    ],
    projects: [{ id: 1, name: 'مشروع الأبحاث' }],
    documents: {
      1: [
        { id: 10, title: 'مقدّمة الكتاب' },
        { id: 11, title: 'الخاتمة' }
      ]
    },
    recent: [{ documentId: 11, projectId: 1, title: 'الخاتمة' }],
    guide: [{ id: 'g1', title: 'دليل التشكيل', run: () => {} }],
    openSettings: () => {},
    openProject: () => {},
    openDocument: () => {},
    ...over
  }
}

describe('palette entries', () => {
  it('builds every kind of entry and skips hidden/disabled commands', () => {
    const ids = buildEntries(sources()).map((e) => e.id)
    expect(ids).toContain('cmd:tabs.new')
    expect(ids).not.toContain('cmd:x.hidden')
    expect(ids).not.toContain('cmd:x.off')
    expect(ids).toEqual(
      expect.arrayContaining(['settings:quran', 'project:1', 'doc:10', 'recent:11', 'guide:g1'])
    )
  })
  it('empty query shows an overview: recent files, commands, settings', () => {
    const groups = searchEntries(buildEntries(sources()), '')
    expect(groups.map((g) => g.id)).toEqual(['recent', 'command', 'settings'])
  })
  it('finds documents by normalised Arabic and groups the result', () => {
    const groups = searchEntries(buildEntries(sources()), 'مقدمه الكتاب')
    expect(groups.map((g) => g.id)).toEqual(['document'])
    expect(groups[0].items[0].id).toBe('doc:10')
  })
  it('finds commands, settings sections, projects and guide topics', () => {
    const e = buildEntries(sources())
    expect(flatten(searchEntries(e, 'تبويب'))[0].id).toBe('cmd:tabs.new')
    expect(flatten(searchEntries(e, 'القران'))[0].id).toBe('settings:quran')
    expect(flatten(searchEntries(e, 'الابحاث')).map((x) => x.id)).toContain('project:1')
    expect(flatten(searchEntries(e, 'دليل')).map((x) => x.id)).toContain('guide:g1')
  })
  it('does not repeat a recent document under documents', () => {
    const flat = flatten(searchEntries(buildEntries(sources()), 'الخاتمه')).map((x) => x.id)
    expect(flat).toContain('recent:11')
    expect(flat).not.toContain('doc:11')
  })
  it('returns no groups when nothing matches', () => {
    expect(searchEntries(buildEntries(sources()), 'zzzzqqq')).toEqual([])
  })
})
