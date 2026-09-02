import { describe, expect, it, vi } from 'vitest'
import {
  claudeQueryOptions,
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
  sdkEnvironmentOverlay,
} from '@deepseek-ai/dsh-subagent-claude-code'
import { claudeSpawnSpec as directSpawn, ManagedClaudeCodeProcess as DirectProcess } from '../../../subagent/subagent-claude-code/src/process.ts'
import { claudeQueryOptions as directOptions } from '../../../subagent/subagent-claude-code/src/run.ts'
import { apply, inject, name } from '../src/index.ts'

type Cleanup = () => void | Promise<void>
type RegisteredProvider = {
  id: string
  dispose(): Promise<void>
  search(request: { query: string }): Promise<unknown>
}

function composition(resolveExecutable: (command: string) => Promise<string> = async command => command) {
  const providers = new Map<string, RegisteredProvider>()
  const cleanups: Cleanup[] = []
  const children = new Set<number>()
  const registerSearchProvider = vi.fn((provider: RegisteredProvider) => {
    if (providers.has(provider.id)) throw Object.assign(new Error('duplicate'), { code: 'WEB_DUPLICATE_PROVIDER' })
    providers.set(provider.id, provider)
    return () => { providers.delete(provider.id) }
  })
  const ctx = {
    web: { registerSearchProvider },
    subprocess: {
      resolveExecutable,
      spawn: () => { children.add(1); throw new Error('unused') },
    },
    effect: vi.fn((factory: () => Generator<Cleanup>) => {
      for (const cleanup of factory()) cleanups.push(cleanup)
    }),
  }
  return {
    ctx: ctx as never,
    providers,
    children,
    registerSearchProvider,
    dispose: async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
    },
  }
}

describe('loader composition', () => {
  it('declares exact seams and preserves shared Claude SDK exports', () => {
    expect(name).toBe('web-search-claude-code')
    expect(inject).toEqual(['web', 'subprocess'])
    expect(claudeSpawnSpec).toBe(directSpawn)
    expect(ManagedClaudeCodeProcess).toBe(DirectProcess)
    expect(claudeQueryOptions).toBe(directOptions)
    expect(typeof sdkEnvironmentOverlay).toBe('function')
  })

  it('registers fixed ID, rejects duplicates, then disposes and unregisters with no children', async () => {
    const fake = composition()
    apply(fake.ctx)
    expect([...fake.providers]).toHaveLength(1)
    expect(fake.providers.has('claude-code')).toBe(true)
    expect(() => { apply(fake.ctx) }).toThrow('duplicate')
    expect(fake.registerSearchProvider).toHaveBeenCalledTimes(2)
    await fake.dispose()
    expect(fake.providers.size).toBe(0)
    expect(fake.children.size).toBe(0)
  })

  it('disposal during blocked executable resolution aborts startup before spawn, then unregisters', async () => {
    let release!: (value: string) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const resolution = new Promise<string>((resolve) => { release = resolve })
    const resolveExecutable = vi.fn(async () => {
      markStarted()
      return await resolution
    })
    const fake = composition(resolveExecutable)
    apply(fake.ctx, { executable: 'claude', requestTimeoutMs: 1000 })
    const provider = fake.providers.get('claude-code')
    expect(provider).toBeDefined()
    const search = provider?.search({ query: 'blocked startup' })
    await started

    const disposal = fake.dispose()
    expect(fake.providers.has('claude-code')).toBe(true)
    release(process.execPath)

    await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    await disposal
    expect(fake.providers.size).toBe(0)
    expect(fake.children.size).toBe(0)
    expect(resolveExecutable).toHaveBeenCalledOnce()
  })

  it('accepts every explicit bound and executable form', () => {
    const low = composition()
    apply(low.ctx, {
      cwd: '.', requestTimeoutMs: 1, disposeGraceMs: 1, maxResults: 1,
      maxTurns: 1, maxPayloadBytes: 1048, executable: 'claude',
    })
    const high = composition()
    apply(high.ctx, {
      cwd: '.', requestTimeoutMs: 600000, disposeGraceMs: 60000, maxResults: 50,
      maxTurns: 16, maxPayloadBytes: 1048576, executable: process.execPath,
    })
    expect(low.providers.has('claude-code')).toBe(true)
    expect(high.providers.has('claude-code')).toBe(true)
  })

  it.each([
    [{ id: 'other' }, 'id cannot be overridden'],
    [{ cwd: '   ' }, 'cwd must be nonblank'],
    [{ executable: '' }, 'executable must be'],
    [{ executable: ' claude' }, 'executable must be'],
    [{ executable: './claude' }, 'executable must be'],
    [{ requestTimeoutMs: 0 }, 'requestTimeoutMs'],
    [{ requestTimeoutMs: 600001 }, 'requestTimeoutMs'],
    [{ requestTimeoutMs: 1.5 }, 'requestTimeoutMs'],
    [{ requestTimeoutMs: Number.MAX_VALUE }, 'requestTimeoutMs'],
    [{ disposeGraceMs: 0 }, 'disposeGraceMs'],
    [{ disposeGraceMs: 60001 }, 'disposeGraceMs'],
    [{ maxResults: 0 }, 'maxResults'],
    [{ maxResults: 51 }, 'maxResults'],
    [{ maxTurns: 0 }, 'maxTurns'],
    [{ maxTurns: 17 }, 'maxTurns'],
    [{ maxPayloadBytes: 1047 }, 'maxPayloadBytes'],
    [{ maxPayloadBytes: 1048577 }, 'maxPayloadBytes'],
  ] as const)('rejects invalid config %# with WEB_INVALID_CONFIG', (config, message) => {
    expect(() => { apply(composition().ctx, config as never) }).toThrow(message)
    try {
      apply(composition().ctx, config as never)
    } catch (error) {
      expect(error).toMatchObject({ code: 'WEB_INVALID_CONFIG' })
    }
  })
})
