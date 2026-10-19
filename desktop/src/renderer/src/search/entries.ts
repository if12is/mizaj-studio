import type { Command } from '@renderer/commands/registry'
import { bestScore } from './fuzzy'

export type GroupId = 'recent' | 'command' | 'settings' | 'project' | 'document' | 'guide'

/** Display order of the palette groups. */
export const GROUPS: { id: GroupId; label: string }[] = [
  { id: 'recent', label: 'الملفات الأخيرة' },
  { id: 'command', label: 'الأوامر' },
  { id: 'settings', label: 'الإعدادات' },
  { id: 'project', label: 'المشاريع' },
  { id: 'document', label: 'المستندات' },
  { id: 'guide', label: 'الدليل' }
]

export interface PaletteEntry {
  id: string
  group: GroupId
  title: string
  subtitle?: string
  shortcut?: string
  keywords?: string[]
  run: () => unknown
}

export interface GuideTopic {
  id: string
  title: string
  keywords?: string[]
  run: () => unknown
}

/** Everything the palette can find; plain data so it is unit-testable without the app. */
export interface PaletteSources {
  commands: Command[]
  settingsSections: { id: string; label: string }[]
  projects: { id: number; name: string }[]
  documents: Record<number, { id: number; title: string }[]>
  recent: { documentId: number; projectId: number; title: string }[]
  guide: GuideTopic[]
  openSettings: (section: string) => void
  openProject: (projectId: number) => void
  openDocument: (documentId: number) => void
}

export function buildEntries(s: PaletteSources): PaletteEntry[] {
  const out: PaletteEntry[] = []
  const projectName = new Map(s.projects.map((p) => [p.id, p.name]))
  for (const r of s.recent)
    out.push({
      id: `recent:${r.documentId}`,
      group: 'recent',
      title: r.title,
      subtitle: projectName.get(r.projectId),
      run: () => s.openDocument(r.documentId)
    })
  for (const c of s.commands) {
    if (c.hidden || (c.enabled && !c.enabled())) continue
    out.push({
      id: `cmd:${c.id}`,
      group: 'command',
      title: c.title,
      subtitle: c.group,
      shortcut: c.shortcut,
      keywords: c.keywords,
      run: c.run
    })
  }
  for (const sec of s.settingsSections)
    out.push({
      id: `settings:${sec.id}`,
      group: 'settings',
      title: `الإعدادات: ${sec.label}`,
      keywords: ['settings', 'preferences', sec.label],
      run: () => s.openSettings(sec.id)
    })
  for (const p of s.projects)
    out.push({
      id: `project:${p.id}`,
      group: 'project',
      title: p.name,
      run: () => s.openProject(p.id)
    })
  for (const p of s.projects)
    for (const d of s.documents[p.id] ?? [])
      out.push({
        id: `doc:${d.id}`,
        group: 'document',
        title: d.title,
        subtitle: p.name,
        run: () => s.openDocument(d.id)
      })
  for (const g of s.guide)
    out.push({
      id: `guide:${g.id}`,
      group: 'guide',
      title: g.title,
      keywords: g.keywords,
      run: g.run
    })
  return out
}

export interface ResultGroup {
  id: GroupId
  label: string
  items: PaletteEntry[]
}

/** Per-group result caps (empty query shows a short overview, a query shows more). */
const LIMIT_EMPTY: Partial<Record<GroupId, number>> = { recent: 6, command: 8, settings: 4 }
const LIMIT_QUERY = 8

/**
 * Fuzzy-filter and group. Empty query = overview (recent files, commands, settings).
 * With a query, documents already listed under «الملفات الأخيرة» are not repeated.
 */
export function searchEntries(entries: PaletteEntry[], query: string): ResultGroup[] {
  const q = query.trim()
  const seenDocs = new Set<string>()
  const groups: ResultGroup[] = []
  for (const g of GROUPS) {
    const own = entries.filter((e) => e.group === g.id)
    let items: PaletteEntry[]
    if (!q) {
      const cap = LIMIT_EMPTY[g.id]
      if (cap === undefined) continue
      items = own.slice(0, cap)
    } else {
      items = own
        .map((e, i) => ({ e, i, s: bestScore(q, [e.title, ...(e.keywords ?? []), e.subtitle]) }))
        .filter((x): x is { e: PaletteEntry; i: number; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, LIMIT_QUERY)
        .map((x) => x.e)
    }
    if (g.id === 'recent') for (const e of items) seenDocs.add(e.id.replace('recent:', 'doc:'))
    if (q && g.id === 'document') items = items.filter((e) => !seenDocs.has(e.id))
    if (items.length) groups.push({ id: g.id, label: g.label, items })
  }
  return groups
}

export const flatten = (groups: ResultGroup[]): PaletteEntry[] => groups.flatMap((g) => g.items)
