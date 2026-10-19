import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSidecarStore } from './sidecar'
import { DEFAULT_SETTINGS, SETTINGS_SECTIONS, useSettingsStore } from './settings'
import { useBatchStore } from './batch'
import { usePacksStore, type PackPreview } from './packs'
import { useOnlineStore } from './online'

type SettingsMapT = Record<string, string>
type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []
let handler: (c: Call) => unknown = () => ({})

function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const c: Call = {
    method: init?.method ?? 'GET',
    url: url.replace('http://t', ''),
    body: init?.body ? JSON.parse(String(init.body)) : undefined
  }
  calls.push(c)
  const out = handler(c)
  return Promise.resolve(new Response(JSON.stringify(out), { status: 200 }))
}

beforeAll(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('fetch', fakeFetch)
  // settings.applyToDom touches the document; a minimal stand-in is enough here
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  vi.stubGlobal('document', {
    documentElement: { classList: { toggle: () => false }, style: { setProperty: () => undefined } }
  })
  useSidecarStore().baseUrl = 'http://t'
})
afterEach(() => {
  calls = []
  handler = () => ({})
})

describe('settings store: openSettings + defaults', () => {
  it('opens on the requested section and falls back to general', () => {
    const s = useSettingsStore()
    s.openSettings('quran')
    expect(s.settingsOpen).toBe(true)
    expect(s.settingsSection).toBe('quran')
    s.closeSettings()
    expect(s.settingsOpen).toBe(false)
    s.openSettings('nope' as never)
    expect(s.settingsSection).toBe('general')
    s.openSettings()
    expect(s.settingsSection).toBe('general')
  })
  it('knows every section the spec lists', () => {
    expect([...SETTINGS_SECTIONS]).toEqual([
      'general',
      'dictionary',
      'glossary',
      'quran',
      'online',
      'packs',
      'backup',
      'editor-quality',
      'systemwide',
      'wordaddin'
    ])
  })
  it('online features are off by default', () => {
    expect(DEFAULT_SETTINGS.online_resources).toBe('false')
    expect(DEFAULT_SETTINGS.online_languagetool).toBe('false')
    expect(DEFAULT_SETTINGS.online_languagetool).toBe('false')
  })
})

describe('batch store', () => {
  it('refuses an invalid form without calling the backend', async () => {
    const b = useBatchStore()
    await b.start({
      input_dir: '',
      output_dir: '/o',
      mode: 'fast',
      level: 'full',
      formats: ['txt'],
      recursive: true,
      on_exist: 'rename',
      track_changes: false
    })
    expect(b.error).toContain('الإدخال')
    expect(calls).toHaveLength(0)
  })
  it('starts a job and polls until it finishes', async () => {
    let polls = 0
    handler = (c) => {
      if (c.method === 'POST') return { job_id: 'j1', total: 2 }
      polls++
      return {
        id: 'j1',
        status: polls > 1 ? 'done' : 'running',
        total: 2,
        done: polls > 1 ? 2 : 1,
        succeeded: 2,
        skipped: 0,
        current: null,
        outputs: [],
        errors: []
      }
    }
    const b = useBatchStore()
    await b.start({
      input_dir: '/i',
      output_dir: '/o',
      mode: 'fast',
      level: 'full',
      formats: ['txt'],
      recursive: true,
      on_exist: 'rename',
      track_changes: false
    })
    expect(b.running).toBe(true)
    await vi.waitFor(() => expect(b.job?.status).toBe('done'), { timeout: 3000 })
    expect(b.running).toBe(false)
    expect(calls[0].url).toBe('/api/batch')
    b.reset()
  })
})

describe('packs store', () => {
  const preview: PackPreview = {
    name: 'p',
    version: '1',
    kinds: ['dictionary'],
    license: 'CC0',
    attribution: '',
    author: '',
    description: '',
    content_sha256: 'abc',
    models: null,
    summary: { dictionary: { adds: 0, updates: 0, conflicts: 1, skips: 0 } },
    items: {
      dictionary: {
        adds: [],
        updates: [],
        skips: [],
        conflicts: [
          { key: 'كتاب', action: 'conflict', reason: 'user_locked', incoming: null, current: null }
        ]
      }
    }
  }
  it('sends the per-conflict choice and the preview checksum on apply', async () => {
    const p = usePacksStore()
    p.preview = preview
    p.previewPath = '/x.mizajpack'
    p.selectedKinds = ['dictionary']
    p.setChoice('dictionary', 'كتاب', 'override')
    handler = (c) =>
      c.url.endsWith('/apply')
        ? {
            import_id: 'i1',
            applied: { dictionary: { added: 0, updated: 1, kept_local: 0 } },
            undoable: true,
            models: null
          }
        : []
    await p.apply()
    const apply = calls.find((c) => c.url === '/api/packs/v2/apply')!
    expect(apply.body).toMatchObject({
      path: '/x.mizajpack',
      kinds: ['dictionary'],
      decisions: { dictionary: { كتاب: 'override' } },
      expected_content_sha256: 'abc'
    })
    expect(p.message?.ok).toBe(true)
    expect(p.preview).toBeNull()
  })
  it('keeps the local entry when no choice was made', async () => {
    const p = usePacksStore()
    p.preview = preview
    p.previewPath = '/x.mizajpack'
    p.selectedKinds = ['dictionary']
    p.choices = {}
    handler = () => ({ import_id: 'i2', applied: {}, undoable: true, models: null })
    await p.apply()
    const apply = calls.find((c) => c.url === '/api/packs/v2/apply')!
    expect((apply.body as { decisions: unknown }).decisions).toEqual({})
  })
  it('requires a license to export', async () => {
    const p = usePacksStore()
    await p.exportPack({
      kinds: ['dictionary'],
      name: 'x',
      version: '1',
      license: ' ',
      author: '',
      attribution: '',
      description: '',
      include_sample_templates: false,
      include_private_settings: false
    })
    expect(p.message?.ok).toBe(false)
    expect(p.message?.text).toContain('الترخيص')
    expect(calls).toHaveLength(0)
  })
})

describe('online store', () => {
  it('turning a switch on persists it through the settings API', async () => {
    handler = (c) =>
      c.method === 'PUT'
        ? { online_languagetool: 'true' }
        : c.url === '/api/resources'
          ? { resources: [] }
          : {}
    const o = useOnlineStore()
    await o.setSwitch('online_languagetool', true)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toBe('/api/settings')
    expect(put.body).toEqual({ online_languagetool: 'true' })
    expect(useSettingsStore().values.online_languagetool).toBe('true')
    await o.setSwitch('online_languagetool', false)
  })
  it('refuses a download without the license checkbox and makes no request', async () => {
    const o = useOnlineStore()
    await o.download('ayaspell-ar', false)
    expect(o.message?.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('settings store: saves go out one at a time, in order', () => {
  it('a second save waits for the first, and the newest value wins locally and on the server', async () => {
    const s = useSettingsStore()
    const sent: SettingsMapT[] = []
    const resolvers: (() => void)[] = []
    let server: SettingsMapT = {}
    vi.stubGlobal('fetch', (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as SettingsMapT
      sent.push(body)
      return new Promise<Response>((res) =>
        resolvers.push(() => {
          server = { ...server, ...body }
          res(new Response(JSON.stringify(server), { status: 200 }))
        })
      )
    })
    const a = s.update({ panel_width: '256' })
    const b = s.update({ panel_width: '240' })
    expect(s.values.panel_width).toBe('240')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toHaveLength(1) // the second PUT is not sent while the first is in flight
    resolvers[0]()
    await a
    expect(s.values.panel_width).toBe('240') // the first echo does not undo the newer value
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    resolvers[1]()
    await b
    expect(server.panel_width).toBe('240')
    expect(s.values.panel_width).toBe('240')
    vi.stubGlobal('fetch', fakeFetch)
  })
})
