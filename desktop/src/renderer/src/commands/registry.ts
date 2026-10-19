import { shallowRef } from 'vue'

/**
 * The single command registry. Every app command / menu action is registered here once; the
 * command palette lists whatever is registered, so a new command shows up there automatically.
 * Commands with a `keybinding` and `global: true` are also triggered by the global key handler.
 */
export interface Command {
  /** unique, dot-separated (e.g. `tabs.new`) */
  id: string
  /** Arabic label shown in the palette */
  title: string
  /** palette group heading; defaults to the commands group */
  group?: string
  /** extra search words (Arabic or English) */
  keywords?: string[]
  /** shortcut text shown to the user (LTR), e.g. `Ctrl+T` */
  shortcut?: string
  /** machine-readable binding(s) like `Mod+Shift+P` (Mod = Ctrl, or Cmd on macOS) */
  keybinding?: string | string[]
  /** true: the global key handler runs it on `keybinding`; otherwise `shortcut` is informational
   *  (the editor/CodeMirror handles the key itself) */
  global?: boolean
  /** true: bindable/runnable but not listed in the palette */
  hidden?: boolean
  /** return false to hide the command right now (re-evaluated at every palette query) */
  enabled?: () => boolean
  run: () => unknown
}

const registry = shallowRef<ReadonlyMap<string, Command>>(new Map())

/** Register (or replace by id) a command; returns an unregister function. */
export function registerCommand(cmd: Command): () => void {
  const next = new Map(registry.value)
  next.set(cmd.id, cmd)
  registry.value = next
  return () => unregisterCommand(cmd.id, cmd)
}
export function registerCommands(cmds: Command[]): () => void {
  const offs = cmds.map(registerCommand)
  return () => offs.forEach((o) => o())
}
export function unregisterCommand(id: string, only?: Command): void {
  if (!registry.value.has(id)) return
  if (only && registry.value.get(id) !== only) return
  const next = new Map(registry.value)
  next.delete(id)
  registry.value = next
}
/** Reactive: reading inside a computed re-evaluates when commands are added/removed. */
export function listCommands(): Command[] {
  return [...registry.value.values()]
}
export function getCommand(id: string): Command | undefined {
  return registry.value.get(id)
}
export function clearCommands(): void {
  registry.value = new Map()
}
export async function runCommand(id: string): Promise<boolean> {
  const c = registry.value.get(id)
  if (!c || (c.enabled && !c.enabled())) return false
  await c.run()
  return true
}

// ------------------------------------------------------------------ key bindings
export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** `Mod+Shift+P`, `Ctrl+Tab`, `Alt+F4`… against a keyboard event. Mod = Ctrl or Cmd. */
export function matchesKeybinding(e: KeyLike, spec: string): boolean {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase())
  const key = parts.pop() ?? ''
  const want = new Set(parts)
  if (want.has('mod')) {
    if (!(e.ctrlKey || e.metaKey)) return false
  } else if (e.ctrlKey !== want.has('ctrl') || e.metaKey !== want.has('meta')) return false
  if (e.shiftKey !== want.has('shift')) return false
  if (e.altKey !== want.has('alt')) return false
  return e.key.toLowerCase() === key
}

/** The global command whose binding matches the event, if any (enabled ones only). */
export function findCommandForKey(e: KeyLike): Command | undefined {
  for (const c of registry.value.values()) {
    if (!c.global || !c.keybinding) continue
    if (c.enabled && !c.enabled()) continue
    const specs = Array.isArray(c.keybinding) ? c.keybinding : [c.keybinding]
    if (specs.some((s) => matchesKeybinding(e, s))) return c
  }
  return undefined
}
