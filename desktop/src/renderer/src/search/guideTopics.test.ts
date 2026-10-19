import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const registered: { id: string }[] = []
vi.mock('./guide', () => ({
  registerGuideTopics: (l: { id: string }[]) => (registered.push(...l), () => {})
}))
const { registerQuickGuideTopics } = await import('./guideTopics')

describe('quick guide topics', () => {
  it('match the headings of docs/guide/quick.md (anchor slugs of the builder)', () => {
    const md = readFileSync(join(__dirname, '../../../../../docs/guide/quick.md'), 'utf8')
    const slug = (t: string): string =>
      t.replace(/[^\w؀-ۿ]+/g, '-').replace(/^-+|-+$/g, '')
    const want = [...md.matchAll(/^#{2,3} (.+)$/gm)].map((m) => `guide.${slug(m[1])}`)
    registerQuickGuideTopics()
    expect(registered.map((t) => t.id)).toEqual(want)
  })
})
