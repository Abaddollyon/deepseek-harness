import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, type SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceFiles from '../src/index.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const CAPS = {
  maxBytes: 1024,
  maxFileBytes: 1024,
  maxLines: 100,
  maxEntries: 100,
  search: { maxResults: 100, maxEntries: 1000, graceMs: 3000, timeoutMs: 30000, stderrMaxBytes: 65536 },
}

function header(id: SessionId, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    origin: 'subagent',
    ...cwd === undefined ? {} : { cwd },
  }
}

describe('Workspace Files Session scope lookup', () => {
  it('prefers the recorded workspace root of a live or stored Session over its header directory', async () => {
    const liveId = brandString<SessionId>('live-relocated')
    const coldId = brandString<SessionId>('cold-relocated')
    const plainId = brandString<SessionId>('cold-plain')
    const liveRoot = resolve('live-workspace')
    const liveWorktree = resolve('live-workspace', '.agents', 'worktrees', 'topic')
    const coldRoot = resolve('cold-workspace')
    const coldWorktree = resolve('elsewhere', 'cold-topic')
    const stat = vi.fn(async (id: SessionId) => {
      if (id === coldId) return { header: header(coldId, coldRoot) }
      if (id === plainId) return { header: header(plainId, coldRoot) }
      return undefined
    })
    const cachedSnapshot = vi.fn((meta: SessionHeader) =>
      meta.id === coldId ? { asOfSeq: 4, values: { workingDirectory: coldWorktree } } : undefined)
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    // A live Session's root is the one the sandbox policy bounds it by.
    const resolvePolicy = vi.fn(() => ({ mode: 'workspace-write', workspaceRoot: liveWorktree }))
    ctx.provide('sandboxPolicy', { workspaceRoot: resolve('fallback-workspace'), resolve: resolvePolicy } as never)
    ctx.provide('sessionPersistence', { stat } as never)
    ctx.provide('sessionProjectionCache', { cachedSnapshot } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)
    try {
      const live = ctx.sessions.create(liveId, { meta: { cwd: liveRoot, origin: 'subagent' } })
      await expect(ctx.workspaceFiles.scopeOf(liveId)).resolves.toEqual({ sessionId: liveId, workspaceRoot: liveWorktree })
      expect(resolvePolicy).toHaveBeenCalledWith({ session: live })
      await expect(ctx.workspaceFiles.scopeOf(coldId)).resolves.toEqual({ sessionId: coldId, workspaceRoot: coldWorktree })
      await expect(ctx.workspaceFiles.scopeOf(plainId)).resolves.toEqual({ sessionId: plainId, workspaceRoot: coldRoot })
      expect(cachedSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: coldId }), ['workingDirectory'])
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')
      await expect(lookup.resolve(liveId)).resolves.toEqual({ sessionId: liveId, workspaceRoot: liveWorktree })
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })

  it('uses live or stored headers without an Agent and leaves with its plugin', async () => {
    const liveId = brandString<SessionId>('live-subagent')
    const coldId = brandString<SessionId>('cold-subagent')
    const fallbackId = brandString<SessionId>('cold-without-cwd')
    const liveFallbackId = brandString<SessionId>('live-without-cwd')
    const missingId = brandString<SessionId>('missing')
    const liveRoot = resolve('live-workspace')
    const coldRoot = resolve('cold-workspace')
    const fallbackRoot = resolve('fallback-workspace')
    const stat = vi.fn(async (id: SessionId) => {
      if (id === coldId) return { header: header(coldId, coldRoot) }
      if (id === fallbackId) return { header: header(fallbackId) }
      return undefined
    })
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    const resolvePolicy = ({ session }: { session: { header: SessionHeader } }) => ({ mode: 'read-only', workspaceRoot: session.header.cwd ?? fallbackRoot })
    ctx.provide('sandboxPolicy', { workspaceRoot: fallbackRoot, resolve: resolvePolicy } as never)
    ctx.provide('sessionPersistence', { stat } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)

    try {
      ctx.sessions.create(liveId, { meta: { cwd: liveRoot, origin: 'subagent' } })
      ctx.sessions.create(liveFallbackId, { meta: { origin: 'subagent' } })
      expect(ctx.get('agents')).toBeUndefined()
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      expect(lookup).toMatchObject({
        parameter: 'workspaceFileScope',
        wire: 'workspaceFileScopeId',
        // A method taking a scope reads the scope's Session as its access-control resource.
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      })
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')

      await expect(lookup.resolve(liveId)).resolves.toEqual({ sessionId: liveId, workspaceRoot: liveRoot })
      await expect(lookup.resolve(liveFallbackId)).resolves.toEqual({ sessionId: liveFallbackId, workspaceRoot: fallbackRoot })
      expect(stat).not.toHaveBeenCalled()
      const signal = new AbortController().signal
      await expect(ctx.workspaceFiles.scopeOf(coldId, signal)).resolves.toEqual({ sessionId: coldId, workspaceRoot: coldRoot })
      expect(stat).toHaveBeenLastCalledWith(coldId, { signal })
      await expect(lookup.resolve(coldId)).resolves.toEqual({ sessionId: coldId, workspaceRoot: coldRoot })
      await expect(lookup.resolve(fallbackId)).resolves.toEqual({ sessionId: fallbackId, workspaceRoot: fallbackRoot })
      await expect(lookup.resolve(missingId)).resolves.toBeUndefined()
      expect(stat.mock.calls.map(([id]) => id)).toEqual([coldId, coldId, fallbackId, missingId])

      await workspaceFiles.dispose()
      expect(ctx.typert.lookups.get('workspaceFileScope')).toBeUndefined()
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })

  it('selects the filesystem of the execution world the Session projection\'s Agent preset owns', async () => {
    const switched = brandString<SessionId>('switched-blank')
    const local = brandString<SessionId>('local')
    const offline = brandString<SessionId>('offline')
    const plain = brandString<SessionId>('plain')
    const cold = brandString<SessionId>('cold-remote')
    const remoteFs = {}
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    const root = resolve('cwd')
    ctx.provide('sandboxPolicy', { workspaceRoot: resolve('fallback'), resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } as never)
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => id === cold ? { header: { ...header(cold, root), agentPreset: 'remote' } } : undefined,
    } as never)
    ctx.provide('agentPresets', {
      serviceForPreset: (id: string, name: string) => id === 'remote' && name === 'fs' ? remoteFs : undefined,
      ownsWorld: (id: string) => id !== 'standard',
    } as never)
    // The projection names the preset a blank Session switched to after its header was written.
    const presetOf: Record<string, string> = { [switched]: 'remote', [local]: 'standard', [offline]: 'host-offline' }
    ctx.provide('sessionQuery', {
      observeSession: (id: SessionId) => Promise.resolve({
        projections: { values: { agentPreset: presetOf[id] } },
        [Symbol.dispose]: () => {},
      }),
    } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)
    try {
      for (const id of [switched, local, offline]) ctx.sessions.create(id, { meta: { cwd: root, agentPreset: 'standard' } })
      ctx.sessions.create(plain, { meta: { cwd: root } })
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')
      await expect(lookup.resolve(switched)).resolves.toEqual({ sessionId: switched, workspaceRoot: root, fs: remoteFs })
      // A Session in the Host's world carries no filesystem; the Host's serves it.
      await expect(lookup.resolve(local)).resolves.toEqual({ sessionId: local, workspaceRoot: root })
      await expect(lookup.resolve(plain)).resolves.toEqual({ sessionId: plain, workspaceRoot: root })
      // A stored Session falls back to its header's preset when no projection names one.
      await expect(ctx.workspaceFiles.scopeOf(cold)).resolves.toEqual({ sessionId: cold, workspaceRoot: root, fs: remoteFs })
      // An owned world without its filesystem never falls back to the Host files.
      await expect(lookup.resolve(offline)).rejects.toThrow('agent preset "host-offline" is not available')
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })

  it('reads through the scope\'s execution-world filesystem and keeps search in the Host world', async () => {
    const target = { targetKey: 'remote-file', displayPath: '/remote/a.txt' }
    const remote = {
      resolve: vi.fn(async () => target),
      lstat: vi.fn(async () => ({ type: 'file' })),
      stat: vi.fn(async () => ({ type: 'file', version: 'v1', size: 3 })),
      processPath: vi.fn(() => '/remote/a.txt'),
    }
    const ctx = new Context()
    // The Host filesystem has no methods: any use of it fails the test.
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: resolve('fallback') } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)
    try {
      const scope = { sessionId: brandString<SessionId>('remote'), workspaceRoot: '/remote', fs: remote as never }
      const signal = new AbortController().signal
      await expect(ctx.workspaceFiles.stat(scope, 'a.txt', signal)).resolves.toEqual({ absolutePath: '/remote/a.txt', version: 'v1', bytes: 3 })
      expect(remote.lstat).toHaveBeenCalledWith('a.txt', { cwd: '/remote' }, signal)
      await expect(ctx.workspaceFiles.search(scope, { query: 'a', excludedPaths: [], includeHidden: false, respectGitignore: true }, signal))
        .rejects.toMatchObject({ code: 'workspace-file/search-failed' })
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })
})
