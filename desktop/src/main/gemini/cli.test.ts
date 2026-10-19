import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askCli,
  classifyFailure,
  CLI_FIXED_PROMPT,
  defaultDeps,
  detectCli,
  DETECT_TIMEOUT_MS,
  findOnPath,
  resolveLaunch,
  type CliDeps
} from './cli'
import { GeminiError } from './errors'

const posix = process.platform !== 'win32'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-cli-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fake(script: string): CliDeps {
  const p = join(dir, 'gemini')
  writeFileSync(p, `#!${process.execPath}\n${script}`)
  chmodSync(p, 0o755)
  return { ...defaultDeps(), env: { PATH: dir, HOME: dir } }
}

describe('resolveLaunch (no shell, no user text in argv)', () => {
  const win: CliDeps = {
    ...defaultDeps(),
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    execPath: 'C:\\app\\mizaj.exe'
  }
  it('uses a fixed ASCII prompt argument on posix', () => {
    const l = resolveLaunch('/usr/bin/gemini', [], { ...defaultDeps(), platform: 'linux' })
    expect(l).toEqual({ command: '/usr/bin/gemini', args: ['-p', CLI_FIXED_PROMPT] })
  })
  it('runs the npm JS entry with the app binary in node mode when the .cmd shim has one', () => {
    const base = join(dir, 'npm')
    const entry = join(base, 'node_modules', '@google', 'gemini-cli', 'dist')
    mkdirSync(entry, { recursive: true })
    writeFileSync(join(entry, 'index.js'), '')
    const l = resolveLaunch(join(base, 'gemini.cmd'), [], win)
    expect(l.command).toBe('C:\\app\\mizaj.exe')
    expect(l.args[0]).toContain('index.js')
    expect(l.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })
  it('falls back to cmd /d /s /c with verbatim, validated arguments', () => {
    const l = resolveLaunch('C:\\Users\\a b\\npm\\gemini.cmd', [], win)
    expect(l.command).toMatch(/cmd\.exe$/i)
    expect(l.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(l.args[3]).toBe(`"C:\\Users\\a b\\npm\\gemini.cmd" -p "${CLI_FIXED_PROMPT}"`)
    expect(l.windowsVerbatimArguments).toBe(true)
  })
  it('refuses a path containing cmd metacharacters', () => {
    expect(() => resolveLaunch('C:\\x&calc\\gemini.cmd', [], win)).toThrow(GeminiError)
    expect(() => resolveLaunch('C:\\x%PATH%\\gemini.cmd', [], win)).toThrow(GeminiError)
  })
})

describe.runIf(posix)('fake gemini on PATH', () => {
  it('decodes UTF-8 once: a multi-byte Arabic character split across chunks stays intact', async () => {
    const d = fake(`
      const b = Buffer.from('بالنسبة للمدعى عليهم', 'utf8')
      process.stdout.write(b.subarray(0, 5))
      setTimeout(() => { process.stdout.write(b.subarray(5)); }, 80)
    `)
    expect(await askCli('x', d)).toBe('بالنسبة للمدعى عليهم')
  })
  it('finds it and reads the version', async () => {
    const d = fake(
      `if (process.argv.includes('--version')) console.log('0.9.1'); else process.exit(1)`
    )
    expect(findOnPath(d.env, 'linux')).toBe(join(dir, 'gemini'))
    const s = await detectCli(d)
    expect(s).toMatchObject({ detected: true, version: '0.9.1' })
  })
  it('is not detected when absent', async () => {
    const s = await detectCli({ ...defaultDeps(), env: { PATH: dir } })
    expect(s.detected).toBe(false)
  })
  it('passes the document on stdin, never in argv', async () => {
    const d = fake(`
let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{
  console.log(JSON.stringify({argv:process.argv.slice(2), stdinLen:s.length, hasDoc:s.includes('نص سري')}))
})`)
    const out = JSON.parse(await askCli('تعليمات\nنص سري للمستند', d))
    expect(out.argv).toEqual(['-p', CLI_FIXED_PROMPT])
    expect(out.hasDoc).toBe(true)
  })
  it('maps a not-logged-in failure to the friendly Arabic message', async () => {
    const d = fake(`console.error('Please sign in: authentication required'); process.exit(1)`)
    await expect(askCli('x', d)).rejects.toMatchObject({
      code: 'cli_login',
      message: 'سجّل الدخول في Gemini CLI أولاً بتشغيل gemini في الطرفية'
    })
  })
  it('maps quota and generic failures', async () => {
    await expect(
      askCli('x', fake(`console.error('429 RESOURCE_EXHAUSTED'); process.exit(1)`))
    ).rejects.toMatchObject({ code: 'quota' })
    await expect(askCli('x', fake(`console.error('boom'); process.exit(2)`))).rejects.toMatchObject(
      { code: 'cli_failed' }
    )
  })
  it('caps output size', async () => {
    const d = fake(`process.stdout.write('a'.repeat(2_000_000)); setInterval(()=>{},1000)`)
    const out = await askCli('x', d)
    expect(out.length).toBeLessThanOrEqual(256 * 1024)
  })
})

describe('classifyFailure', () => {
  it('detects login problems', () => {
    expect(classifyFailure('not logged in', '').code).toBe('cli_login')
    expect(classifyFailure('', '').code).toBe('cli_failed')
  })
})

describe('timeouts on Windows', () => {
  it('kill the whole process tree with taskkill, not just the cmd wrapper', async () => {
    vi.useFakeTimers()
    try {
      writeFileSync(join(dir, 'gemini.cmd'), '@echo off\r\n')
      const calls: string[][] = []
      const child = Object.assign(new EventEmitter(), {
        pid: 4321,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { end: () => undefined, on: () => undefined },
        kill: vi.fn(() => true)
      })
      const spawn = vi.fn((cmd: string, args: string[]) => {
        calls.push([cmd, ...args])
        return child
      }) as unknown as CliDeps['spawn']
      const p = detectCli({ spawn, env: { PATH: dir }, platform: 'win32', execPath: 'C:\\app.exe' })
      await vi.advanceTimersByTimeAsync(DETECT_TIMEOUT_MS + 10)
      expect(calls.some((c) => c[0] === 'taskkill' && c.includes('/T') && c.includes('4321'))).toBe(
        true
      )
      expect(child.kill).not.toHaveBeenCalled()
      child.emit('close', 1)
      expect((await p).detected).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
