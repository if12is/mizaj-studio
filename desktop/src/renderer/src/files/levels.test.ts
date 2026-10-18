import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8')

const LABEL = 'إلزامي: أواخر الكلمات والتنوين والشدة'

describe('tashkeel level "essential"', () => {
  it.each([
    'components/SettingsModal.vue',
    'components/EditorPane.vue',
    'components/files/BatchDialog.vue'
  ])('%s offers the essential level with its Arabic label', (file) => {
    expect(read(file)).toContain(`<option value="essential">${LABEL}</option>`)
  })

  it('the batch form type allows it', () => {
    expect(read('files/batch.ts')).toContain("'essential'")
  })

  it('the level dropdowns keep a stable order (full, irab_only, essential, ... legal)', () => {
    for (const file of ['components/SettingsModal.vue', 'components/EditorPane.vue']) {
      const src = read(file)
      const order = ['"full"', '"irab_only"', '"essential"', '"minimal"', '"legal"'].map((v) =>
        src.indexOf(`<option value=${v}`)
      )
      expect(order.every((i) => i >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    }
  })
})
