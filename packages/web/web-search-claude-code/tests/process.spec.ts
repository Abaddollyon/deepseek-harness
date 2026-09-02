import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
  sdkEnvironmentOverlay,
} from '../src/process.ts'

afterEach(() => { vi.unstubAllEnvs() })

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly settle: (outcome: SubprocessOutcome) => void
  readonly fail: (error: unknown) => void
  readonly terminate: Mock<SubprocessHandle['terminate']>
}

function fakeChild(): FakeChild {
  let resolve!: (outcome: SubprocessOutcome) => void
  let reject!: (error: unknown) => void
  const done = new Promise<SubprocessOutcome>((accept, decline) => { resolve = accept; reject = decline })
  void done.catch(() => {})
  const terminate = vi.fn<SubprocessHandle['terminate']>()
  const handle = {
    pid: 42,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: undefined,
    collected: {},
    done,
    terminate,
    waitForExit: vi.fn(() => done.then(() => true, () => true)),
  } as SubprocessHandle
  return { handle, settle: resolve, fail: reject, terminate }
}

function spawnOptions(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    command: '/official/claude',
    args: ['--output-format', 'stream-json'],
    cwd: '/workspace',
    env: { A: 'one' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

describe('Claude SDK process projection', () => {
  it('projects exact SDK spawn fields and environment tombstones', () => {
    vi.stubEnv('SDK_REMOVED_AMBIENT', 'ambient')
    const signal = new AbortController().signal
    const options = spawnOptions({ env: { A: 'one', B: undefined }, signal })
    expect(sdkEnvironmentOverlay(options.env)).toEqual(expect.objectContaining({
      A: 'one', B: undefined, SDK_REMOVED_AMBIENT: undefined,
    }))
    expect(sdkEnvironmentOverlay({ SDK_REMOVED_AMBIENT: 'sdk-value' }).SDK_REMOVED_AMBIENT)
      .toBe('sdk-value')
    const spec = claudeSpawnSpec(options, 321)
    expect(spec).toMatchObject({
      argv: ['/official/claude', '--output-format', 'stream-json'],
      cwd: '/workspace',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 321,
      signal,
    })
    expect(spec.env).toEqual(expect.objectContaining({ A: 'one', SDK_REMOVED_AMBIENT: undefined }))
    expect(claudeSpawnSpec(spawnOptions({ command: String.raw`C:\Claude\claude.exe` }), 7).argv[0])
      .toBe(String.raw`C:\Claude\claude.exe`)
  })

  it('rejects missing SDK working directories', () => {
    const missing = spawnOptions()
    delete missing.cwd
    expect(() => claudeSpawnSpec(missing, 1)).toThrow('SDK spawn request omitted its workspace')
    expect(() => claudeSpawnSpec(spawnOptions({ cwd: '' }), 1))
      .toThrow('SDK spawn request omitted its workspace')
  })

  it('projects streams, lifecycle listeners, exit facts, and idempotent termination', async () => {
    const child = fakeChild()
    const projected = new ManagedClaudeCodeProcess(child.handle)
    expect(projected.stdin).toBe(child.handle.stdin)
    expect(projected.stdout).toBe(child.handle.stdout)
    expect(projected.killed).toBe(false)
    expect(projected.exitCode).toBeNull()
    expect(projected.signalCode).toBeNull()
    expect(projected.outcome).toBeUndefined()
    const persistent = vi.fn()
    const once = vi.fn()
    const removed = vi.fn()
    projected.on('exit', persistent)
    projected.once('exit', once)
    projected.on('exit', removed)
    projected.off('exit', removed)
    expect(projected.kill('SIGTERM')).toBe(true)
    expect(projected.killed).toBe(true)
    expect(projected.kill('SIGKILL')).toBe(false)
    expect(child.terminate).toHaveBeenCalledOnce()
    child.settle({ exitCode: null, signal: 'SIGTERM' })
    await nextTask()
    expect(persistent).toHaveBeenCalledWith(null, 'SIGTERM')
    expect(once).toHaveBeenCalledOnce()
    expect(removed).not.toHaveBeenCalled()
    expect(projected.signalCode).toBe('SIGTERM')
    expect(projected.outcome).toEqual({ exitCode: null, signal: 'SIGTERM' })
  })

  it('projects direct exit codes and rejected spawn handles', async () => {
    const exited = fakeChild()
    const projected = new ManagedClaudeCodeProcess(exited.handle)
    exited.settle({ exitCode: 7, signal: null })
    await nextTask()
    expect(projected.exitCode).toBe(7)
    expect(projected.signalCode).toBeNull()
    expect(projected.kill('SIGTERM')).toBe(false)

    const failed = fakeChild()
    const rejected = new ManagedClaudeCodeProcess(failed.handle)
    const error = vi.fn()
    const removed = vi.fn()
    rejected.once('error', error)
    rejected.on('error', removed)
    rejected.off('error', removed)
    failed.fail('non-error spawn failure')
    await nextTask()
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'non-error spawn failure' }))
    expect(removed).not.toHaveBeenCalled()
  })
})
