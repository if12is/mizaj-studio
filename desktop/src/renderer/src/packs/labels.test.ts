import { describe, expect, it } from 'vitest'
import { buildDecisions, reasonLabel, valueText, type PlanGroups, type PlanItem } from './labels'

const it_ = (key: string, action: PlanItem['action']): PlanItem => ({
  key,
  action,
  reason: 'x',
  incoming: null,
  current: null
})
const groups = (g: Partial<PlanGroups>): PlanGroups => ({
  adds: [],
  updates: [],
  conflicts: [],
  skips: [],
  ...g
})

describe('pack labels', () => {
  it('translates known reasons and invalid details', () => {
    expect(reasonLabel('user_locked')).toContain('مقفل')
    expect(reasonLabel('invalid: bad var')).toBe('غير صالح: bad var')
    expect(reasonLabel('weird')).toBe('weird')
  })
  it('extracts readable values', () => {
    expect(valueText({ diacritized_form: 'كِتَابٌ' })).toBe('كِتَابٌ')
    expect(valueText({ preview: 'عقد' })).toBe('عقد')
    expect(valueText('x')).toBe('x')
    expect(valueText(null)).toBe('—')
  })
  it('sends only non-default decisions', () => {
    const plans = {
      dictionary: groups({
        conflicts: [it_('a', 'conflict'), it_('b', 'conflict')],
        updates: [it_('c', 'update'), it_('d', 'update')]
      }),
      templates: groups({ conflicts: [it_('t|c', 'conflict')] })
    }
    const d = buildDecisions(plans, {
      dictionary: { a: 'override', b: 'keep', c: 'keep', d: 'override' },
      templates: { 't|c': 'duplicate' }
    })
    expect(d).toEqual({
      dictionary: { a: 'override', c: 'keep' },
      templates: { 't|c': 'duplicate' }
    })
  })
})
