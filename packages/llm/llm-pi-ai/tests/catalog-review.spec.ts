import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LiveCatalog } from '../src/live-catalog.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import * as LlmPiAi from '../src/index.ts'
import type { LiveCatalogOptions } from '../src/live-catalog.ts'

const disk = vi.hoisted(() => ({ hold: undefined as { entered: () => void; release: Promise<undefined> } | undefined }))
vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
    const hold = disk.hold
    if (hold !== undefined) {
      disk.hold = undefined
      hold.entered()
      await hold.release
    }
    return actual.writeFileAtomic(...args)
  } }
})

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  disk.hold = undefined
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-catalog-review-'))
  roots.push(root)
  return root
}

function options(root: string, account: () => string): LiveCatalogOptions {
  const config = { providers: { openai: { modelDiscovery: { enabled: true, timeoutMs: 100 } } } }
  return {
    current: () => config,
    auth: {
      credentials: {
        read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {},
      },
      authContext: { env: async name => name === 'OPENAI_API_KEY' ? account() : undefined, fileExists: async () => false },
    },
    resolveApiKey: async () => undefined,
    home: root, warn: () => {}, changed: () => {},
  }
}

function catalog(config: LiveCatalogOptions): LiveCatalog {
  const instance = new LiveCatalog(config)
  cleanups.push(() => instance.dispose())
  return instance
}

describe('catalog review regressions', () => {
  it.each(['deadline', 'caller abort'])('R3 bounds cold unknown lookup by %s while known selection stays immediate', async (cause) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const config = options(await home(), () => 'account')
    const raw = { providers: { openai: { models: [{ id: 'known' }], modelDiscovery: { enabled: true, timeoutMs: 100 } } } }
    config.current = () => raw
    config.auth.credentials.read = async () => { entered.resolve(undefined); await gate.promise; return undefined }
    const instance = catalog(config)
    const adapter = new PiAiAdapter({
      profiles: () => instance.profiles(), auth: config.auth, resolveApiKey: config.resolveApiKey,
      ensureModel: (provider, model, signal) => instance.ensureModel(provider, model, signal),
    })
    const controller = new AbortController()
    let outcome = 'pending'
    const missing = adapter.prepareCall('openai', 'unknown', controller.signal).then(
      () => { outcome = 'success' }, (error: unknown) => { outcome = (error as { code: string }).code },
    )
    try {
      await entered.promise
      expect((await adapter.prepareCall('openai', 'known')).model.id).toBe('known')
      if (cause === 'caller abort') controller.abort()
      await vi.advanceTimersByTimeAsync(cause === 'deadline' ? 100 : 0)
      expect(outcome).toBe(cause === 'deadline' ? 'UNKNOWN_MODEL' : 'ABORTED')
      await instance.dispose()
    } finally {
      gate.resolve(undefined)
      await missing
    }
  })

  it('R1 isolates offline restored catalogs by the actual ambient account', async () => {
    const root = await home()
    let account = 'ambient-account-a'
    const config = options(root, () => account)
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'account-a-model' }] }))
    const first = catalog(config)
    await first.refresh('openai')
    await first.dispose()
    account = 'ambient-account-b'
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const restarted = catalog(config)
    await expect(restarted.refresh('openai')).rejects.toThrow(/discovery/)
    expect(restarted.profiles().get('openai')?.piProvider.getModels().map(model => model.id)).not.toContain('account-a-model')
    account = 'ambient-account-a'
    const originalAccount = catalog(config)
    await expect(originalAccount.refresh('openai')).rejects.toThrow(/discovery/)
    expect(originalAccount.profiles().get('openai')?.piProvider.getModels().map(model => model.id)).toContain('account-a-model')
  })

  it('R1 invalidates an ambient credential reference in the running plugin', async () => {
    const root = await home()
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('OPENAI_API_KEY', '')
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { path: join(root, 'credentials.yaml'), watch: false })
    await ctx.credentials.set(credentialRef('OPENAI_API_KEY'), 'account-a')
    vi.stubGlobal('fetch', async (_url: URL, request: RequestInit) => Response.json({ data: [{
      id: new Headers(request.headers).get('authorization') === 'Bearer account-a' ? 'account-a-model' : 'account-b-model',
    }] }))
    await ctx.plugin(LlmPiAi, { providers: { openai: { modelDiscovery: { enabled: true } } } })
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })
    await ctx.credentials.set(credentialRef('OPENAI_API_KEY'), 'account-b')
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })
    const ids = (await ctx.llm.listModels('openai')).map(model => model.id)
    expect(ids).toContain('account-b-model')
    expect(ids).not.toContain('account-a-model')
    const files = await readdir(join(root, 'cache', 'llm-pi-ai'))
    for (const file of files) expect(await readFile(join(root, 'cache', 'llm-pi-ai', file), 'utf8')).not.toContain('Bearer')
  })

  it('R2 bounds a stalled credential read and detaches its read-only completion at disposal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const config = options(await home(), () => 'account')
    config.auth.credentials.read = async () => { entered.resolve(undefined); await gate.promise; return undefined }
    let network = 0
    vi.stubGlobal('fetch', async () => { network++; return Response.json({ data: [{ id: 'late' }] }) })
    const instance = catalog(config)
    let outcome = 'pending'
    const result = instance.refresh('openai').then(() => { outcome = 'success' }, () => { outcome = 'failure' })
    let drained = false
    let disposal: Promise<void> | undefined
    try {
      await entered.promise
      await vi.advanceTimersByTimeAsync(100)
      expect(outcome).toBe('failure')
      disposal = instance.dispose().then(() => { drained = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(drained).toBe(true)
    } finally {
      gate.resolve(undefined)
      await result
      await disposal
    }
    expect(network).toBe(0)
    expect(instance.profiles().get('openai')?.piProvider.getModels().map(model => model.id)).not.toContain('late')
  })

  it.each(['timed-out', 'superseded'])('R2 prevents a %s disk write from overwriting a newer successful cache', async (cause) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const root = await home()
    const config = options(root, () => 'account')
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    disk.hold = { entered: () =>{  entered.resolve(undefined) }, release: gate.promise }
    let model = 'late-old-model'
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: model }] }))
    const instance = catalog(config)
    let outcome = 'pending'
    const result = instance.refresh('openai').then(() => { outcome = 'success' }, () => { outcome = 'failure' })
    let disposal: Promise<void> | undefined
    try {
      await entered.promise
      model = 'new-success-model'
      if (cause === 'superseded') instance.invalidate('openai')
      await vi.advanceTimersByTimeAsync(cause === 'timed-out' ? 100 : 0)
      expect(outcome).toBe('failure')
      await instance.refresh('openai')
      let drained = false
      disposal = instance.dispose().then(() => { drained = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(drained).toBe(false)
    } finally {
      gate.resolve(undefined)
      await result
      await disposal
    }
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const restarted = catalog(config)
    await expect(restarted.refresh('openai')).rejects.toThrow(/discovery/)
    const ids = restarted.profiles().get('openai')?.piProvider.getModels().map(entry => entry.id)
    expect(ids).toContain('new-success-model')
    expect(ids).not.toContain('late-old-model')
    expect((await readdir(join(root, 'cache', 'llm-pi-ai'))).every(file => file.endsWith('.json'))).toBe(true)
  })
})
