import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { PythonProcessManager, resolvePythonExe, type SidecarStatus } from './pythonManager'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  killed: string[] = []
  kill = vi.fn((sig?: string) => {
    this.killed.push(sig ?? 'SIGTERM')
    return true
  })
}

function setup(extra = {}) {
  const children: FakeChild[] = []
  const spawn = vi.fn(() => {
    const c = new FakeChild()
    children.push(c)
    return c as unknown as ChildProcess
  })
  const mgr = new PythonProcessManager({
    pythonExe: 'py',
    backendDir: '/b',
    dataDir: '/d',
    spawn,
    platform: 'linux',
    ...extra
  })
  const states: SidecarStatus[] = []
  mgr.on('sidecar:status-changed', (s: SidecarStatus) => states.push(s))
  return { mgr, children, spawn, states }
}
const ready = (c: FakeChild, port = 54321): void => {
  c.stdout.emit('data', Buffer.from(`MIZAJ_PO`))
  c.stdout.emit('data', Buffer.from(`RT=${port}\nMIZAJ_STATUS=READY\n`))
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('API token handoff', () => {
  const TOKEN = 'ab'.repeat(32)
  it('goes to the child via env only, never argv, and is reused on restart', () => {
    const { mgr, children, spawn } = setup({ apiToken: TOKEN, retryDelaysMs: [10] })
    mgr.start()
    const first = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> }
    ]
    expect(first[2].env.MIZAJ_API_TOKEN).toBe(TOKEN)
    expect(first[1].join(' ')).not.toContain(TOKEN)
    children[0].emit('exit', 1, null)
    vi.advanceTimersByTime(20)
    const second = spawn.mock.calls[1] as unknown as [
      string,
      string[],
      { env: Record<string, string> }
    ]
    expect(second[2].env.MIZAJ_API_TOKEN).toBe(TOKEN)
    expect(second[1].join(' ')).not.toContain(TOKEN)
  })
  it('overrides an inherited MIZAJ_API_TOKEN', () => {
    process.env.MIZAJ_API_TOKEN = 'inherited'
    try {
      const { mgr, spawn } = setup({ apiToken: TOKEN })
      mgr.start()
      expect(
        (spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2]
          .env.MIZAJ_API_TOKEN
      ).toBe(TOKEN)
    } finally {
      delete process.env.MIZAJ_API_TOKEN
    }
  })
})

describe('PythonProcessManager', () => {
  it('spawns with windowsHide and expected args, parses port across chunks', () => {
    const { mgr, children, spawn } = setup()
    mgr.start()
    const [exe, args, opts] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>
    ]
    expect(exe).toBe('py')
    expect(args).toEqual([
      '-m',
      'app.main',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      '/d'
    ])
    expect(opts.windowsHide).toBe(true)
    expect(opts.cwd).toBe('/b')
    expect((opts.env as Record<string, string>).MIZAJ_PARENT_PID).toBe(String(process.pid))
    expect((opts.env as Record<string, string>).PYTHONUNBUFFERED).toBe('1')
    ready(children[0])
    expect(mgr.getStatus()).toMatchObject({ state: 'ready', port: 54321, retry: 0 })
  })

  it('restarts with 1s/2s/4s backoff then gives up as crashed', () => {
    const { mgr, children, spawn } = setup()
    mgr.start()
    children[0].emit('exit', 1, null)
    expect(mgr.getStatus()).toMatchObject({ state: 'restarting', retry: 1 })
    vi.advanceTimersByTime(999)
    expect(spawn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(spawn).toHaveBeenCalledTimes(2)
    children[1].emit('exit', null, 'SIGSEGV')
    vi.advanceTimersByTime(1999)
    expect(spawn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(spawn).toHaveBeenCalledTimes(3)
    children[2].emit('exit', 2, null)
    vi.advanceTimersByTime(3999)
    expect(spawn).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(1)
    expect(spawn).toHaveBeenCalledTimes(4)
    children[3].emit('exit', 2, null)
    expect(mgr.getStatus().state).toBe('crashed')
    vi.advanceTimersByTime(60_000)
    expect(spawn).toHaveBeenCalledTimes(4)
  })

  it('resets retry counter after staying ready for 30s', () => {
    const { mgr, children } = setup()
    mgr.start()
    children[0].emit('exit', 1, null)
    vi.advanceTimersByTime(1000)
    ready(children[1])
    expect(mgr.getStatus().retry).toBe(1)
    vi.advanceTimersByTime(30_000)
    expect(mgr.getStatus().retry).toBe(0)
  })

  it('does not restart when quitting; stop sends SIGTERM then SIGKILL after 3s', async () => {
    const { mgr, children, spawn } = setup()
    mgr.start()
    ready(children[0])
    const p = mgr.stop()
    expect(children[0].killed).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(3000)
    expect(children[0].killed).toEqual(['SIGTERM', 'SIGKILL'])
    children[0].emit('exit', null, 'SIGKILL')
    await p
    vi.advanceTimersByTime(10_000)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(mgr.getStatus().state).toBe('stopped')
  })

  it('kills a hung startup after 20s and restarts', () => {
    const { mgr, children, spawn } = setup()
    mgr.start()
    vi.advanceTimersByTime(20_000)
    expect(children[0].killed).toContain('SIGKILL')
    children[0].emit('exit', null, 'SIGKILL')
    vi.advanceTimersByTime(1000)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('uses taskkill tree kill on win32', () => {
    const killTree = vi.fn()
    const { mgr, children } = setup({ platform: 'win32', killTree })
    mgr.start()
    void mgr.stop()
    expect(killTree).toHaveBeenCalledWith(4242)
    children[0].emit('exit', 1, null)
  })
})

describe('resolvePythonExe', () => {
  it('prefers MIZAJ_PYTHON, then venv, then python3', () => {
    expect(resolvePythonExe({ MIZAJ_PYTHON: '/x/py' }, '/b', 'linux', () => true)).toBe('/x/py')
    expect(resolvePythonExe({}, '/b', 'linux', () => true)).toBe('/b/.venv/bin/python')
    expect(resolvePythonExe({}, '/b', 'linux', () => false)).toBe('python3')
    expect(resolvePythonExe({}, 'C:\\b', 'win32', () => false)).toBe('python')
  })
})

describe('PythonProcessManager launch options', () => {
  it('packaged mode: prefixArgs empty, extraEnv passed, pid exposed', () => {
    const { mgr, spawn, children } = setup({ prefixArgs: [], extraEnv: { MIZAJ_MODELS_DIR: '/m' } })
    mgr.start()
    const [, args, opts] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>
    ]
    expect(args).toEqual(['--host', '127.0.0.1', '--port', '0', '--data-dir', '/d'])
    expect((opts.env as Record<string, string>).MIZAJ_MODELS_DIR).toBe('/m')
    expect(opts.windowsHide).toBe(true)
    expect(mgr.getPid()).toBe(4242)
    children[0].emit('exit', 1, null)
  })
})
