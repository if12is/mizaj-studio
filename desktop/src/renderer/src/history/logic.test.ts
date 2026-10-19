import { describe, expect, it } from 'vitest'
import {
  acceptedLabel,
  arDigits,
  dayLabel,
  deltaLabels,
  entryTitle,
  groupByDay,
  hasChanges,
  previewSegments,
  replaceAllLabel,
  restoreLabel,
  timeLabel,
  type VersionMeta
} from './logic'

// local-time constructors so the tests do not depend on the machine's time zone
const at = (y: number, mo: number, d: number, h: number, mi: number): string =>
  new Date(y, mo - 1, d, h, mi).toISOString()

function v(id: number, created_at: string, over: Partial<VersionMeta> = {}): VersionMeta {
  return {
    id,
    document_id: 1,
    created_at,
    updated_at: created_at,
    kind: 'autosave',
    label: 'تعديل يدوي',
    name: '',
    char_count: 10,
    word_count: 2,
    words_added: 0,
    words_removed: 0,
    chars_delta: 0,
    ...over
  }
}

describe('history labels', () => {
  it('arDigits converts to Arabic-Indic digits', () => {
    expect(arDigits(2026)).toBe('٢٠٢٦')
    expect(arDigits('14:30')).toBe('١٤:٣٠')
  })
  it('timeLabel is local HH:MM in Arabic digits', () => {
    expect(timeLabel(at(2026, 10, 19, 9, 5))).toBe('٠٩:٠٥')
    expect(timeLabel(at(2026, 10, 19, 23, 59))).toBe('٢٣:٥٩')
  })
  it('deltaLabels shows +/− word counts', () => {
    expect(deltaLabels({ words_added: 3, words_removed: 12 })).toEqual({ plus: '+٣', minus: '−١٢' })
  })
  it('entryTitle appends the checkpoint name', () => {
    expect(entryTitle({ label: 'نقطة استرجاع', name: 'مسودة' })).toBe('نقطة استرجاع: «مسودة»')
    expect(entryTitle({ label: 'تشكيل كامل', name: '' })).toBe('تشكيل كامل')
  })
  it('acceptedLabel agrees in number', () => {
    expect(acceptedLabel(1)).toBe('قبول اقتراح تدقيق واحد')
    expect(acceptedLabel(2)).toBe('قبول اقتراحي تدقيق')
    expect(acceptedLabel(5)).toBe('قبول ٥ اقتراحات تدقيق')
    expect(acceptedLabel(12)).toBe('قبول ١٢ اقتراح تدقيق')
  })
  it('replaceAllLabel counts occurrences', () => {
    expect(replaceAllLabel(7)).toBe('استبدال الكل (٧ موضع)')
  })
})

describe('day grouping', () => {
  const now = new Date(2026, 9, 19, 15, 0)
  it('labels today / yesterday / older days', () => {
    expect(dayLabel('2026-10-19', now)).toBe('اليوم')
    expect(dayLabel('2026-10-18', now)).toBe('أمس')
    expect(dayLabel('2026-10-03', now)).toBe('٢٠٢٦-١٠-٠٣')
  })
  it('groups a newest-first list by local day and keeps the order', () => {
    const items = [
      v(5, at(2026, 10, 19, 14, 30)),
      v(4, at(2026, 10, 19, 9, 0)),
      v(3, at(2026, 10, 18, 22, 10)),
      v(2, at(2026, 10, 3, 8, 0)),
      v(1, at(2026, 10, 3, 7, 0))
    ]
    const g = groupByDay(items, now)
    expect(g.map((x) => x.label)).toEqual(['اليوم', 'أمس', '٢٠٢٦-١٠-٠٣'])
    expect(g.map((x) => x.items.map((i) => i.id))).toEqual([[5, 4], [3], [2, 1]])
  })
  it('an empty list gives no groups', () => {
    expect(groupByDay([], now)).toEqual([])
  })
  it('restoreLabel carries the time, plus the day when not today', () => {
    expect(restoreLabel({ created_at: at(2026, 10, 19, 14, 30) }, now)).toBe('استعادة نسخة ١٤:٣٠')
    expect(restoreLabel({ created_at: at(2026, 10, 18, 9, 5) }, now)).toBe('استعادة نسخة أمس ٠٩:٠٥')
  })
})

describe('previewSegments', () => {
  it('maps version->current ops to gain/lose/same', () => {
    const segs = previewSegments([
      { op: 'equal', text: 'بسم ' },
      { op: 'delete', text: 'الله' },
      { op: 'insert', text: 'الرحمن' },
      { op: 'equal', text: ' الرحيم' }
    ])
    expect(segs).toEqual([
      { kind: 'same', text: 'بسم ' },
      { kind: 'gain', text: 'الله' },
      { kind: 'lose', text: 'الرحمن' },
      { kind: 'same', text: ' الرحيم' }
    ])
  })
  it('shortens long unchanged runs around the change but never the changes', () => {
    const long = 'كلمة '.repeat(100)
    const segs = previewSegments(
      [
        { op: 'equal', text: long },
        { op: 'insert', text: 'جديد' },
        { op: 'equal', text: long }
      ],
      20
    )
    expect(segs[0].text.length).toBeLessThan(long.length)
    expect(segs[0].text.endsWith(long.slice(-20))).toBe(true)
    expect(segs[1]).toEqual({ kind: 'lose', text: 'جديد' })
    expect(segs[2].text.startsWith(long.slice(0, 20))).toBe(true)
    expect(segs[2].text).toContain('…')
  })
  it('hasChanges ignores equal and empty ops', () => {
    expect(hasChanges([{ op: 'equal', text: 'x' }])).toBe(false)
    expect(hasChanges([])).toBe(false)
    expect(hasChanges([{ op: 'insert', text: 'y' }])).toBe(true)
  })
})
