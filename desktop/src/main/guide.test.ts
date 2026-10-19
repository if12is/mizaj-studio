import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, dialog: {}, session: {} }))
const { guidePageOf } = await import('./guide')

describe('guidePageOf', () => {
  const dir = join(process.cwd(), 'guide-dir')
  const url = (p: string): string => pathToFileURL(join(dir, p)).href

  it('accepts only the two guide pages in the guide folder', () => {
    expect(guidePageOf(url('quick.html'), dir)).toBe('quick')
    expect(guidePageOf(url('guide.html') + '#s2', dir)).toBe('guide')
    expect(guidePageOf(url('other.html'), dir)).toBeNull()
    expect(guidePageOf(pathToFileURL(join(dir, '..', 'quick.html')).href, dir)).toBeNull()
    expect(guidePageOf('https://example.com/quick.html', dir)).toBeNull()
    expect(guidePageOf('not a url', dir)).toBeNull()
  })
})
