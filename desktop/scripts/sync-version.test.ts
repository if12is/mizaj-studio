import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { resolveVersion, syncVersion } = require('./sync-version.cjs') as {
  resolveVersion(env: Record<string, string>): { version: string | null; source: string }
  syncVersion(p: string, env: Record<string, string>): { version: string; changed: boolean }
}

describe('sync-version', () => {
  it('uses RELEASE_VERSION over the tag and strips a leading v', () => {
    expect(resolveVersion({ RELEASE_VERSION: 'v1.2.3', GITHUB_REF_NAME: 'v9.9.9' }).version).toBe(
      '1.2.3'
    )
  })
  it('uses the tag name', () => {
    expect(resolveVersion({ GITHUB_REF_NAME: 'v0.1.1', GITHUB_REF_TYPE: 'tag' }).version).toBe(
      '0.1.1'
    )
  })
  it('accepts prerelease semver', () => {
    expect(resolveVersion({ RELEASE_VERSION: '1.0.0-beta.1' }).version).toBe('1.0.0-beta.1')
  })
  it('fails clearly for invalid versions', () => {
    expect(() => resolveVersion({ RELEASE_VERSION: '1.2' })).toThrow(/Invalid version/)
    expect(() => resolveVersion({ GITHUB_REF_NAME: 'v1.x', GITHUB_REF_TYPE: 'tag' })).toThrow(
      /semver/
    )
    expect(() => resolveVersion({ RELEASE_VERSION: 'latest' })).toThrow()
  })
  it('branch dispatch without version keeps package.json', () => {
    expect(
      resolveVersion({ GITHUB_REF_NAME: 'main', GITHUB_REF_TYPE: 'branch' }).version
    ).toBeNull()
  })
  it('writes package.json', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'sv-')), 'package.json')
    writeFileSync(p, JSON.stringify({ name: 'x', version: '0.0.1' }))
    const r = syncVersion(p, { RELEASE_VERSION: '2.0.0' })
    expect(r.changed).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8')).version).toBe('2.0.0')
    expect(syncVersion(p, { GITHUB_REF_NAME: 'main' }).version).toBe('2.0.0')
  })
})
