import { describe, expect, it } from 'vitest'
import { alignClusters, failCode, mapOps } from './align'

describe('alignClusters / mapOps', () => {
  it('clusters equal to the text: no gaps', () => {
    expect(alignClusters('كَتاب', ['كَ', 'ت', 'ا', 'ب'])).toEqual({
      ok: true,
      spans: [
        { start: 0, end: 2 },
        { start: 2, end: 3 },
        { start: 3, end: 4 },
        { start: 4, end: 5 }
      ]
    })
  })
  it('tolerates skipped spaces, tabs and direction marks', () => {
    const r = alignClusters('ا \tب‏', ['ا', 'ب'])
    expect(r).toMatchObject({
      ok: true,
      spans: [
        { start: 0, end: 1 },
        { start: 3, end: 4 }
      ]
    })
  })
  it('a skipped LETTER is not tolerated; the code has code points only', () => {
    const r = alignClusters('ابت', ['ا', 'ت'])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(failCode(r.fail)).toBe('map-mismatch len=3 got=2 n=2 firstDiff=@1 U+0628/U+062A')
      expect(JSON.stringify(r.fail)).not.toContain('ابت')
    }
  })
  it('no clusters at all / trailing letters are failures', () => {
    expect(alignClusters('اب', [])).toMatchObject({ ok: false, fail: { code: 'map-empty' } })
    expect(alignClusters('اب', ['ا'])).toMatchObject({ ok: false, fail: { code: 'map-tail' } })
  })
  it('an op on skipped spaces becomes a gap op', () => {
    const r = mapOps(
      'ا  ،',
      ['ا', '،'],
      [
        { index: 2, kind: 'delete' },
        { index: 1, kind: 'delete' }
      ]
    )
    expect(r).toMatchObject({
      ok: true,
      mapped: { gapOps: [{ gap: 1, text: '' }], clusterOps: [] }
    })
  })
})
