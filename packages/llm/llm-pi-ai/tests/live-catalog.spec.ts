import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveCatalog } from '../src/live-catalog.ts'
import type { LiveCatalogOptions } from '../src/live-catalog.ts'
import type { Config } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const disk = vi.hoisted(() => ({
  rename: undefined as undefined | (() => Promise<void>),
  cleanup: undefined as undefined | (() => Promise<void>),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (String(args[0]).endsWith('.pending')) await disk.rename?.()
    return actual.rename(...args)
  }, rm: async (...args: Parameters<typeof actual.rm>) => {
    await actual.rm(...args)
    if (String(args[0]).endsWith('.pending')) await disk.cleanup?.()
  } }
})

const roots: string[] = []
const catalogs: LiveCatalog[] = []
const release: Array<() => void> = []
afterEach(async () => {
  for (const resolve of release.splice(0)) resolve()
  for (const catalog of catalogs.splice(0)) await catalog.dispose()
  disk.rename = undefined
  disk.cleanup = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(config: Config = { providers: { openai: { models: [{ id: 'configured' }], modelDiscovery: { enabled: true } } } }) {
  const home = await mkdtemp(join(tmpdir(), 'pi-live-catalog-'))
  roots.push(home)
  const auth = memoryAuth({ openai: { type: 'api_key', key: 'catalog-key' } })
  const current = { config }
  const changed = vi.fn()
  const warn = vi.fn()
  const options: LiveCatalogOptions = {
    current: () => current.config, auth, home, changed, warn,
    resolveApiKey: () => Promise.resolve(undefined),
  }
  function create() {
    const catalog = new LiveCatalog(options)
    catalogs.push(catalog)
    return catalog
  }
  return { home, auth, current, options, changed, warn, create }
}

function ids(catalog: LiveCatalog, provider = 'openai'): string[] {
  return catalog.profiles().get(provider)?.piProvider.getModels().map(model => model.id) ?? []
}

function gate<T>() {
  const value = Promise.withResolvers<T>()
  return value
}

describe('live catalog lifecycle and durable cache', () => {
  it('keeps known models immediate and refuses refresh after removal or disposal', async () => {
    const setup = await fixture()
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'discovered' }] }))
    const catalog = setup.create()
    await catalog.refresh('openai')
    await expect(catalog.ensureModel('openai', 'configured')).resolves.toBeUndefined()
    await expect(catalog.ensureModel('missing', 'unknown')).resolves.toBeUndefined()
    await expect(catalog.refresh('missing')).rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED' })
    await catalog.dispose()
    setup.current.config = { providers: { anthropic: { modelDiscovery: { enabled: true } } } }
    expect(catalog.profiles().has('anthropic')).toBe(true)
    await expect(catalog.refresh('anthropic')).rejects.toMatchObject({ code: 'DISCOVERY_UNSUPPORTED' })
  })

  it('forwards credential listing and deletion without publishing catalog updates', async () => {
    const setup = await fixture({})
    const catalog = setup.create()
    const credentials = catalog.renewalAuth().credentials
    expect(await credentials.list()).toEqual([{ providerId: 'openai', type: 'api_key' }])
    await credentials.delete('openai')
    expect(await credentials.read('openai')).toBeUndefined()
    expect(setup.changed).not.toHaveBeenCalled()
  })

  it('waits for cold restoration before applying a generation credential mutation', async () => {
    const setup = await fixture()
    const entered = gate<undefined>()
    const read = gate<undefined>()
    release.push(() => { read.resolve(undefined) })
    const original = setup.auth.credentials.read.bind(setup.auth.credentials)
    setup.auth.credentials.read = async (...args) => { entered.resolve(undefined); await read.promise; return original(...args) }
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'discovered' }] }))
    const catalog = setup.create()
    catalog.profiles()
    await entered.promise
    const mutate = vi.fn(async () => ({ type: 'api_key' as const, key: 'replacement' }))
    const mutation = catalog.renewalAuth().credentials.modify('openai', mutate)
    await Promise.resolve(undefined)
    expect(mutate).not.toHaveBeenCalled()
    read.resolve(undefined)
    await expect(mutation).resolves.toEqual({ type: 'api_key', key: 'replacement' })
    await catalog.refresh('openai')
    expect(ids(catalog)).toContain('discovered')
  })

  it('fences restoration when disposal follows credential resolution before the combined read resumes', async () => {
    const setup = await fixture()
    const read = gate<Awaited<ReturnType<typeof setup.auth.credentials.read>>>()
    release.push(() => { read.resolve(undefined) })
    setup.auth.credentials.read = () => read.promise
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const catalog = setup.create()
    const refresh = catalog.refresh('openai')
    const outcome = expect(refresh).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    let disposal: Promise<void> | undefined
    // The credential reader settles before its owner's shutdown, while Promise.all still owes its continuation.
    void read.promise.then(() => { queueMicrotask(() => { disposal = catalog.dispose() }) })
    read.resolve({ type: 'api_key', key: 'resolved-key' })
    await outcome
    await disposal
    expect(fetch).not.toHaveBeenCalled()
    expect(setup.changed).not.toHaveBeenCalled()
  })

  it('does not discover with missing credentials and recovers after a committed key arrives', async () => {
    const setup = await fixture()
    setup.auth.stored.clear()
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'discovered' }] }))
    vi.stubGlobal('fetch', fetch)
    const catalog = setup.create()
    await expect(catalog.refresh('openai')).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(fetch).not.toHaveBeenCalled()
    setup.auth.stored.set('openai', { type: 'api_key', key: 'new-key' })
    catalog.credentialsReady()
    await catalog.refresh('openai')
    expect(ids(catalog)).toEqual(['discovered', 'configured'])
  })

  it('does not invalidate an identified route for an unrelated reference', async () => {
    const setup = await fixture()
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'discovered' }] }))
    vi.stubGlobal('fetch', fetch)
    const catalog = setup.create()
    await catalog.refresh('openai')
    catalog.invalidateReference('UNRELATED')
    expect(ids(catalog)).toContain('discovered')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([false, true])('invalidates unidentified ambient reads but not unrelated explicit references (explicit=%s)', async (explicit) => {
    const setup = await fixture({ providers: { openai: {
      ...explicit ? { apiKeyEnv: 'EXPLICIT' } : {}, modelDiscovery: { enabled: true },
    } } })
    const entered = gate<undefined>()
    const read = gate<undefined>()
    release.push(() => { read.resolve(undefined) })
    let calls = 0
    setup.options.resolveApiKey = async () => { calls++; entered.resolve(undefined); await read.promise; return 'key' }
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'discovered' }] }))
    const catalog = setup.create()
    catalog.profiles()
    await entered.promise
    catalog.invalidateReference('UNRELATED')
    expect(calls).toBe(explicit ? 1 : 2)
    read.resolve(undefined)
    await catalog.refresh('openai')
    expect(ids(catalog)).toContain('discovered')
  })

  it('rejects an unknown-model waiter when its route is removed during discovery', async () => {
    const setup = await fixture()
    const entered = gate<undefined>()
    const response = gate<Response>()
    release.push(() => { response.resolve(Response.json({ data: [{ id: 'late' }] })) })
    vi.stubGlobal('fetch', async () => { entered.resolve(undefined); return response.promise })
    const catalog = setup.create()
    const wait = catalog.ensureModel('openai', 'late', new AbortController().signal)
    const outcome = expect(wait).rejects.toMatchObject({ code: 'ABORTED' })
    await entered.promise
    setup.current.config = {}
    catalog.profiles()
    await outcome
    expect(ids(catalog)).toEqual([])
  })

  it.each([
    ['synchronous Error', false, new Error('credential unavailable')],
    ['synchronous rejection value', false, 'credential unavailable'],
    ['asynchronous rejection value', true, 'credential unavailable'],
  ] as const)('contains %s from a credential dependency', async (_name, asynchronous, error) => {
    const setup = await fixture()
    setup.options.resolveApiKey = () => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Credential dependencies may reject with non-Error values.
      if (asynchronous) return Promise.reject(error)
      throw error
    }
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const catalog = setup.create()
    await expect(catalog.refresh('openai')).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(ids(catalog)).toEqual(['configured'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds the complete retained cache by bytes, not merely the latest response', async () => {
    const setup = await fixture()
    let prefix = 'first'
    vi.stubGlobal('fetch', async () => Response.json({ data: Array.from({ length: 1000 }, (_, index) => ({
      id: `${prefix}-${index}-${'界'.repeat(490)}`, name: '界'.repeat(512),
    })) }))
    const catalog = setup.create()
    await catalog.refresh('openai')
    const directory = join(setup.home, 'cache', 'llm-pi-ai')
    const filename = join(directory, (await readdir(directory))[0]!)
    const before = await readFile(filename, 'utf8')
    prefix = 'second'
    await expect(catalog.refresh('openai')).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(ids(catalog)).toHaveLength(1001)
    expect(ids(catalog).some(id => id.startsWith('second'))).toBe(false)
    expect(await readFile(filename, 'utf8')).toBe(before)
  })

  it('fences metadata if the configuration changes before publication', async () => {
    const setup = await fixture()
    const entered = gate<undefined>()
    const response = gate<Response>()
    release.push(() => { response.resolve(Response.json({ data: [{ id: 'late' }] })) })
    vi.stubGlobal('fetch', async () => { entered.resolve(undefined); return response.promise })
    const catalog = setup.create()
    const refresh = catalog.refresh('openai')
    const failed = expect(refresh).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    await entered.promise
    // No consumer has observed the new configuration yet; fetch itself must fence it.
    setup.current.config = {}
    response.resolve(Response.json({ data: [{ id: 'late' }] }))
    await failed
    expect(ids(catalog)).toEqual([])
    await expect(readdir(join(setup.home, 'cache', 'llm-pi-ai'))).rejects.toThrow()
  })

  it.each(['timeout', 'dispose'] as const)('keeps a committed OAuth renewal successful when cache migration ends by %s', async (cause) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const setup = await fixture({ providers: { anthropic: {
      models: [{ id: 'configured' }], modelDiscovery: { enabled: true },
    } } })
    setup.auth.stored.set('anthropic', { type: 'oauth', access: 'sk-ant-oat-old', refresh: 'old', expires: Date.now() + 600_000 })
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'discovered' }] }))
    const catalog = setup.create()
    await catalog.refresh('anthropic')
    const entered = gate<undefined>()
    const resume = gate<undefined>()
    release.push(() => { resume.resolve(undefined) })
    disk.rename = async () => { disk.rename = undefined; entered.resolve(undefined); await resume.promise }
    const renewed = { type: 'oauth' as const, access: 'sk-ant-oat-new', refresh: 'new', expires: Date.now() + 600_000 }
    const mutation = catalog.renewalAuth().credentials.modify('anthropic', async () => renewed)
    await entered.promise
    let disposal: Promise<void> | undefined
    if (cause === 'dispose') disposal = catalog.dispose()
    else await vi.advanceTimersByTimeAsync(15000)
    await expect(mutation).resolves.toEqual(renewed)
    expect(setup.auth.stored.get('anthropic')).toEqual(renewed)
    expect(setup.warn).toHaveBeenCalledTimes(cause === 'dispose' ? 0 : 1)
    resume.resolve(undefined)
    await disposal
    expect(ids(catalog, 'anthropic')).toContain('discovered')
  })

  it('serializes a successor cache commit after an older migration is superseded during rename', async () => {
    const setup = await fixture({ providers: { anthropic: {
      models: [{ id: 'configured' }], modelDiscovery: { enabled: true },
    } } })
    setup.auth.stored.set('anthropic', { type: 'oauth', access: 'sk-ant-oat-old', refresh: 'old', expires: Date.now() + 600_000 })
    let model = 'first'
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: model }] }))
    const catalog = setup.create()
    await catalog.refresh('anthropic')
    const entered = gate<undefined>()
    const resume = gate<undefined>()
    release.push(() => { resume.resolve(undefined) })
    disk.rename = async () => { disk.rename = undefined; entered.resolve(undefined); await resume.promise }
    const mutation = catalog.renewalAuth().credentials.modify('anthropic', async () => ({ type: 'oauth', access: 'sk-ant-oat-new', refresh: 'new', expires: Date.now() + 600_000 }))
    await entered.promise
    model = 'second'
    const refresh = catalog.refresh('anthropic')
    // The successor must reach its atomic-write boundary before the old rename settles.
    await vi.waitFor(async () => {
      const files = await readdir(join(setup.home, 'cache', 'llm-pi-ai'))
      expect(files.filter(file => file.endsWith('.pending'))).toHaveLength(2)
    })
    resume.resolve(undefined)
    await mutation
    await refresh
    await catalog.dispose()
    expect(ids(catalog, 'anthropic')).toEqual(['first', 'second', 'configured'])
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const restarted = setup.create()
    await expect(restarted.refresh('anthropic')).rejects.toThrow(/discovery/)
    expect(ids(restarted, 'anthropic')).toEqual(['first', 'second', 'configured'])
    expect((await readdir(join(setup.home, 'cache', 'llm-pi-ai'))).every(file => file.endsWith('.json'))).toBe(true)
  })

  it.each(['refresh', 'renewal'] as const)('does not publish a superseded %s after staging cleanup', async (operation) => {
    const setup = await fixture({ providers: { anthropic: {
      models: [{ id: 'configured' }], modelDiscovery: { enabled: true },
    } } })
    setup.auth.stored.set('anthropic', { type: 'oauth', access: 'sk-ant-oat-old', refresh: 'old', expires: Date.now() + 600_000 })
    let model = 'initial'
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: model }] }))
    const catalog = setup.create()
    await catalog.refresh('anthropic')
    const entered = gate<undefined>()
    const resume = gate<undefined>()
    release.push(() => { resume.resolve(undefined) })
    disk.cleanup = async () => { disk.cleanup = undefined; entered.resolve(undefined); await resume.promise }
    const renew = (id: string) => catalog.renewalAuth().credentials.modify('anthropic', async () => ({
      type: 'oauth', access: `sk-ant-oat-${id}`, refresh: id, expires: Date.now() + 600_000,
    }))
    model = 'superseded'
    const first = operation === 'refresh' ? catalog.refresh('anthropic') : renew('first')
    const outcome = operation === 'refresh'
      ? expect(first).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
      : expect(first).resolves.toMatchObject({ access: 'sk-ant-oat-first' })
    await entered.promise
    await renew('successor')
    resume.resolve(undefined)
    await outcome
    expect(ids(catalog, 'anthropic')).toEqual(['initial', 'configured'])
    await catalog.dispose()
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const restarted = setup.create()
    await expect(restarted.refresh('anthropic')).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(ids(restarted, 'anthropic')).toEqual(['initial', 'configured'])
  })

  it.each([
    ['null', 'null'],
    ['primitive', '42'],
    ['oversized', ' '.repeat(4 * 1024 * 1024 + 1)],
    ['combined-entry-limit', JSON.stringify({ version: 2, models: Array.from({ length: 1100 }, (_, id) => ({ id: `model-${id}` })), excludedIds: Array.from({ length: 1100 }, (_, id) => `excluded-${id}`) })],
  ])('ignores a %s cache without publishing its metadata', async (_name, contents) => {
    const setup = await fixture()
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'cached' }] }))
    const first = setup.create()
    await first.refresh('openai')
    await first.dispose()
    const directory = join(setup.home, 'cache', 'llm-pi-ai')
    const filename = join(directory, (await readdir(directory))[0]!)
    await writeFile(filename, contents)
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    setup.changed.mockClear()
    const restored = setup.create()
    await expect(restored.refresh('openai')).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(ids(restored)).toEqual(['configured'])
    expect(setup.changed).not.toHaveBeenCalled()
    expect(await readFile(filename, 'utf8')).toBe(contents)
  })
})
