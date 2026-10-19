import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCommands,
  findCommandForKey,
  getCommand,
  listCommands,
  matchesKeybinding,
  registerCommand,
  registerCommands,
  runCommand,
  unregisterCommand
} from './registry'
import { buildEntries } from '@renderer/search/entries'

const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}
) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

afterEach(() => clearCommands())

describe('command registry', () => {
  it('registers, lists, replaces by id and unregisters', () => {
    const off = registerCommand({ id: 'a', title: 'أ', run: () => {} })
    registerCommand({ id: 'b', title: 'ب', run: () => {} })
    expect(listCommands().map((c) => c.id)).toEqual(['a', 'b'])
    registerCommand({ id: 'a', title: 'أ2', run: () => {} })
    expect(getCommand('a')?.title).toBe('أ2')
    expect(listCommands()).toHaveLength(2)
    off() // stale handle: the replaced command is a different object, so it stays
    expect(getCommand('a')).toBeDefined()
    unregisterCommand('a')
    expect(getCommand('a')).toBeUndefined()
  })

  it('a new command shows up in the palette entries automatically', () => {
    const base = {
      settingsSections: [],
      projects: [],
      documents: {},
      recent: [],
      guide: [],
      openSettings: () => {},
      openProject: () => {},
      openDocument: () => {}
    }
    expect(buildEntries({ ...base, commands: listCommands() })).toHaveLength(0)
    registerCommands([{ id: 'new.cmd', title: 'أمر جديد', shortcut: 'Ctrl+J', run: () => {} }])
    const e = buildEntries({ ...base, commands: listCommands() })
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ id: 'cmd:new.cmd', title: 'أمر جديد', shortcut: 'Ctrl+J' })
  })

  it('runCommand runs enabled commands only', async () => {
    const run = vi.fn()
    registerCommand({ id: 'ok', title: 'x', run })
    registerCommand({ id: 'off', title: 'y', enabled: () => false, run })
    expect(await runCommand('ok')).toBe(true)
    expect(await runCommand('off')).toBe(false)
    expect(await runCommand('missing')).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('key bindings', () => {
  it('matches Mod (ctrl or meta), shift and exact modifiers', () => {
    expect(matchesKeybinding(key('k', { ctrlKey: true }), 'Mod+K')).toBe(true)
    expect(matchesKeybinding(key('k', { metaKey: true }), 'Mod+K')).toBe(true)
    expect(matchesKeybinding(key('K', { ctrlKey: true }), 'Mod+K')).toBe(true)
    expect(matchesKeybinding(key('k'), 'Mod+K')).toBe(false)
    expect(matchesKeybinding(key('P', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+P')).toBe(true)
    expect(matchesKeybinding(key('p', { ctrlKey: true }), 'Mod+Shift+P')).toBe(false)
    expect(matchesKeybinding(key('t', { ctrlKey: true, shiftKey: true }), 'Mod+T')).toBe(false)
    expect(matchesKeybinding(key('Tab', { ctrlKey: true }), 'Ctrl+Tab')).toBe(true)
    expect(matchesKeybinding(key('Tab', { ctrlKey: true, shiftKey: true }), 'Ctrl+Tab')).toBe(false)
    expect(matchesKeybinding(key('Tab', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Tab')).toBe(
      true
    )
  })

  it('findCommandForKey only returns enabled global commands', () => {
    registerCommands([
      { id: 'g', title: 'g', keybinding: ['Mod+K', 'Mod+Shift+P'], global: true, run: () => {} },
      { id: 'local', title: 'l', keybinding: 'Mod+L', run: () => {} },
      {
        id: 'off',
        title: 'o',
        keybinding: 'Mod+O',
        global: true,
        enabled: () => false,
        run: () => {}
      }
    ])
    expect(findCommandForKey(key('k', { ctrlKey: true }))?.id).toBe('g')
    expect(findCommandForKey(key('P', { ctrlKey: true, shiftKey: true }))?.id).toBe('g')
    expect(findCommandForKey(key('l', { ctrlKey: true }))).toBeUndefined()
    expect(findCommandForKey(key('o', { ctrlKey: true }))).toBeUndefined()
  })
})
