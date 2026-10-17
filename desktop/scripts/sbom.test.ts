import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const sbom = require('./sbom.cjs') as {
  normalizeLicense(s: string): string
  isCompatible(s: string): boolean
  checkLicenses(
    c: { name: string; version: string; license: string }[],
    ex?: Record<string, string>
  ): {
    incompatible: { name: string }[]
    unknown: { name: string }[]
  }
  toCycloneDx(
    c: unknown[],
    v: string,
    now?: Date
  ): {
    bomFormat: string
    specVersion: string
    components: {
      name: string
      purl?: string
      licenses?: { license: { id?: string; name?: string } }[]
    }[]
    metadata: { component: { version: string } }
  }
  renderLicenses(c: unknown[], v: string): string
}

const c = (name: string, license: string, ecosystem: string | null = 'npm') => ({
  name,
  version: '1.0.0',
  license,
  ecosystem
})

describe('license policy (GPL-3.0-or-later compatibility)', () => {
  it('flags GPL-2.0-only, proprietary and non-commercial licenses', () => {
    for (const l of ['GPL-2.0-only', 'GPL-2.0', 'proprietary', 'SSPL-1.0', 'CC-BY-NC-4.0'])
      expect(sbom.isCompatible(l)).toBe(false)
  })
  it('accepts permissive and GPL-3 compatible licenses, incl. OR expressions', () => {
    for (const l of [
      'MIT',
      'Apache-2.0',
      'BSD-3-Clause',
      'MPL-2.0',
      'OFL-1.1',
      'GPL-3.0-or-later',
      'LGPL-3.0-only',
      'AGPL-3.0-only',
      'MPL-2.0 OR LGPL-2.1-or-later',
      'GPL-2.0-only OR MIT',
      'GPL-2.0-or-later WITH Bootloader-exception'
    ])
      expect(sbom.isCompatible(l)).toBe(true)
  })
  it('reports incompatible and unknown components; exceptions override', () => {
    const r = sbom.checkLicenses([c('a', 'MIT'), c('b', 'GPL-2.0-only'), c('c', '')])
    expect(r.incompatible.map((x) => x.name)).toEqual(['b'])
    expect(r.unknown.map((x) => x.name)).toEqual(['c'])
    expect(
      sbom.checkLicenses([c('b', 'GPL-2.0-only')], { b: 'GPL-2.0-or-later' }).incompatible
    ).toEqual([])
    expect(sbom.normalizeLicense('(MIT)')).toBe('MIT')
  })
})

describe('CycloneDX output and license file', () => {
  const comps = [
    c('@scope/pkg', 'MIT'),
    c('requests', 'Apache-2.0', 'pypi'),
    c('Amiri font', 'OFL-1.1', null)
  ]
  it('is a valid-looking CycloneDX 1.5 BOM with purls and licenses', () => {
    const bom = sbom.toCycloneDx(comps, '0.2.0', new Date('2026-01-01T00:00:00Z'))
    expect(bom.bomFormat).toBe('CycloneDX')
    expect(bom.specVersion).toBe('1.5')
    expect(bom.metadata.component.version).toBe('0.2.0')
    expect(bom.components[0].purl).toBe('pkg:npm/@scope/pkg@1.0.0')
    expect(bom.components[1].purl).toBe('pkg:pypi/requests@1.0.0')
    expect(bom.components[0].licenses?.[0].license.id).toBe('MIT')
    expect(bom.components[2].purl).toBeUndefined()
  })
  it('THIRD_PARTY_LICENSES names GPL-3.0-or-later, the tagged source URL and every component', () => {
    const t = sbom.renderLicenses(comps, '0.2.0')
    expect(t).toContain('GPL-3.0-or-later')
    expect(t).toContain('github.com/if12is/mizaj-studio/tree/v0.2.0')
    expect(t).toContain('@scope/pkg 1.0.0  [MIT]')
    expect(t).toContain('requests 1.0.0  [Apache-2.0]')
    expect(t).toContain('Amiri font')
  })
})
