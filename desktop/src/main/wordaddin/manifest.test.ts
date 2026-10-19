import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADDIN_PORT,
  COMMAND_FUNCTIONS,
  buildManifest,
  readManifestFacts,
  validateManifestStructure
} from './manifest'

const template = readFileSync(
  resolve(__dirname, '../../../word-addin/manifest.template.xml'),
  'utf8'
)
const params = {
  id: '5f1c2b7e-3a44-4c1f-9b0e-0d6e8a1c9a11',
  port: ADDIN_PORT,
  token: 'A'.repeat(43)
}
const xml = buildManifest(template, params)

describe('manifest generation', () => {
  it('fills every placeholder and passes the structural validation', () => {
    expect(xml).not.toContain('{{')
    expect(validateManifestStructure(xml)).toEqual([])
  })
  it('uses only https://localhost:<port> URLs and the pairing token in the page URLs', () => {
    const urls = [...xml.matchAll(/https?:\/\/localhost:\d+[^"<]*/g)].map((m) => m[0])
    expect(urls.length).toBeGreaterThan(8)
    for (const u of urls) expect(u.startsWith(`https://localhost:${ADDIN_PORT}`)).toBe(true)
    expect(xml).toContain(`/taskpane.html?k=${params.token}`)
    expect(xml).toContain(`/commands.html?k=${params.token}`)
  })
  it('has the four ribbon buttons and the task pane button, in order', () => {
    const labels = [
      ...xml.matchAll(/<bt:String id="Mizaj\.\w+\.Label" DefaultValue="([^"]+)"/g)
    ].map((m) => m[1])
    expect(labels).toEqual([
      'مِزَاج',
      'مِزَاج',
      'إملائي',
      'ترقيم',
      'تشكيل',
      'الكل',
      'معاينة واستبدال'
    ])
    for (const fn of Object.values(COMMAND_FUNCTIONS))
      expect(xml).toContain(`<FunctionName>${fn}</FunctionName>`)
    expect(xml).toContain('<Action xsi:type="ShowTaskpane">')
  })
  it('round-trips its facts', () => {
    expect(readManifestFacts(xml)).toEqual({ id: params.id, port: ADDIN_PORT, token: params.token })
  })
  it('a fresh id gives a different manifest; the Id is lower-cased', () => {
    const b = buildManifest(template, { ...params, id: params.id.toUpperCase() })
    expect(readManifestFacts(b).id).toBe(params.id)
  })
  it('refuses malformed parameters instead of writing a broken manifest', () => {
    expect(() => buildManifest(template, { ...params, id: 'nope' })).toThrow()
    expect(() => buildManifest(template, { ...params, token: 'short' })).toThrow()
    expect(() => buildManifest(template, { ...params, token: '"><x/>'.padEnd(40, 'a') })).toThrow()
    expect(() => buildManifest(template, { ...params, port: 80 })).toThrow()
    expect(() => buildManifest('<a>{{NOPE}}</a>', params)).toThrow()
  })
})

describe('structural validator catches real mistakes', () => {
  it('plain http, dangling resid, bad order', () => {
    expect(
      validateManifestStructure(xml.replace('https://localhost', 'http://localhost')).length
    ).toBeGreaterThan(0)
    expect(validateManifestStructure(xml.replace('resid="Mizaj.Icon16"', 'resid="Nope"'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'resid' })])
    )
    const swapped = xml
      .replace('<Version>1.0.0.0</Version>', '')
      .replace('<Id>', '<Version>1.0.0.0</Version><Id>')
    expect(validateManifestStructure(swapped).length).toBeGreaterThan(0)
  })
  it('too long labels', () => {
    const long = xml.replace('DefaultValue="إملائي"', `DefaultValue="${'ا'.repeat(40)}"`)
    expect(validateManifestStructure(long)).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'label-length' })])
    )
  })
})
