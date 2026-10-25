import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FEATURES,
  RESOURCE_FEATURE,
  STATUS_LABEL,
  featureOf,
  locationText,
  toolStatus
} from './registry'
import {
  actionToasts,
  dismissActionToast,
  runToastAction,
  showActionToast
} from '@renderer/composables/useActionToast'
import { markFeatureNew, markFeatureUsed, newFeatures } from '@renderer/composables/useNewFeatures'

const SRC = resolve(__dirname, '..')
function allVue(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? allVue(p) : p.endsWith('.vue') ? [p] : []
  })
}
const sources = allVue(join(SRC, 'components')).map((p) => readFileSync(p, 'utf8'))

describe('feature registry', () => {
  it('every selector and reveal selector points at a real data-testid in the UI', () => {
    for (const [id, f] of Object.entries(FEATURES)) {
      const info = f as { selector: string; reveal?: string }
      for (const sel of [info.selector, info.reveal]) {
        if (!sel) continue
        const tid = /data-testid="([^"]+)"/.exec(sel)?.[1]
        expect(tid, `${id}: selector must use data-testid`).toBeTruthy()
        expect(
          sources.some((s) => s.includes(`data-testid="${tid}"`)),
          `${id}: data-testid ${tid} not found in components`
        ).toBe(true)
      }
    }
  })

  it('every feature has an Arabic location and description', () => {
    for (const f of Object.values(FEATURES)) {
      for (const t of [f.where, f.description]) expect(t).toMatch(/[؀-ۿ]/)
    }
  })

  it('catalog resources map to known features and the toast text names the location', () => {
    for (const f of Object.values(RESOURCE_FEATURE)) expect(FEATURES[f]).toBeTruthy()
    expect(featureOf('ayaspell-ar')).toBe('spellDictionary')
    expect(featureOf('tashkeela-sample')).toBeNull()
    expect(locationText('gemini')).toBe('تجده الآن في: شريط الأدوات ← اسأل عن المستند')
  })

  it('maps every catalog id that has UI', () => {
    const catalog = JSON.parse(
      readFileSync(resolve(SRC, '../../../../backend/app/resources/catalog.json'), 'utf8')
    )
    const ids: string[] = (catalog.resources ?? catalog).map((r: { id: string }) => r.id)
    for (const id of ids) if (id !== 'tashkeela-sample') expect(featureOf(id), id).not.toBeNull()
  })
})

describe('status labels', () => {
  it('tools', () => {
    expect(toolStatus(false, true)).toBe('missing')
    expect(toolStatus(undefined, true)).toBe('missing')
    expect(toolStatus(true, true)).toBe('running')
    expect(toolStatus(true, false)).toBe('off')
    expect(STATUS_LABEL.off).toBe('مثبّت — غير مفعّل')
    expect(STATUS_LABEL.running).toBe('مثبّت ومفعّل ✓')
    expect(STATUS_LABEL.missing).toBe('غير مثبّت')
  })
})

describe('action toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    actionToasts.value = []
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs actions, dismisses, and calls onDismiss once', async () => {
    const onDismiss = vi.fn()
    const run = vi.fn()
    const id = showActionToast({ text: 'x', ms: 1000, onDismiss, actions: [{ label: 'a', run }] })
    expect(actionToasts.value).toHaveLength(1)
    await runToastAction(actionToasts.value[0], actionToasts.value[0].actions[0])
    expect(run).toHaveBeenCalledOnce()
    expect(actionToasts.value).toHaveLength(0)
    dismissActionToast(id)
    vi.advanceTimersByTime(2000)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('auto-dismisses after ms; ms 0 stays', () => {
    showActionToast({ text: 'short', ms: 500 })
    showActionToast({ text: 'sticky', ms: 0 })
    vi.advanceTimersByTime(600)
    expect(actionToasts.value.map((t) => t.text)).toEqual(['sticky'])
  })
})

describe('new-feature badges', () => {
  it('mark new once, clear on first use', () => {
    newFeatures.value = []
    markFeatureNew('gemini')
    markFeatureNew('gemini')
    expect(newFeatures.value).toEqual(['gemini'])
    markFeatureUsed('ocr')
    expect(newFeatures.value).toEqual(['gemini'])
    markFeatureUsed('gemini')
    expect(newFeatures.value).toEqual([])
  })
})
