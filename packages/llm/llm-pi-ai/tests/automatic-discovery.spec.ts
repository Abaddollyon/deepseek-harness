import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as LlmPiAi from '../src/index.ts'
import { resolveProfiles } from '../src/config.ts'

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

async function boot(home?: string, overrides: Partial<LlmPiAi.PiAiProviderProfile> = {}): Promise<Context> {
  if (home === undefined) {
    home = await mkdtemp(join(tmpdir(), 'pi-auto-models-'))
    homes.push(home)
  }
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('KIMI_DISCOVERY_TEST_KEY', '')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.credentials.set(credentialRef('KIMI_DISCOVERY_TEST_KEY'), 'metadata-test-key')
  await ctx.plugin(LlmPiAi, {
    providers: {
      'kimi-coding': {
        apiKeyEnv: 'KIMI_DISCOVERY_TEST_KEY',
        modelDiscovery: { enabled: true },
        models: [{ id: 'kimi-for-coding', contextWindow: 77777, maxTokens: 4096 }],
        ...overrides,
      },
    },
  })
  return ctx
}

describe('automatic model discovery', () => {
  it('publishes one shared selectable and resolvable catalog without changing explicit models', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: [
      { id: 'new-kimi', context_length: 131072, think_efforts: ['low', 'high', 'ultra'] },
      { id: 'kimi-for-coding', context_length: 99999 },
    ] }))
    const ctx = await boot()
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    const listed = await ctx.llm.listModels('kimi-coding')
    expect(listed.map(model => model.id)).toContain('new-kimi')
    const resolved = await ctx.llm.resolveModelInfo('kimi-coding', 'new-kimi')
    expect(resolved.context?.contextWindow).toBe(131072)
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'high'])
    expect((await ctx.llm.resolveModelInfo('kimi-coding', 'kimi-for-coding')).context?.contextWindow).toBe(77777)
  })

  it('keeps the good catalog on an empty refresh and reports failure to the caller', async () => {
    let data: unknown[] = [{ id: 'new-kimi' }]
    vi.stubGlobal('fetch', async () => Response.json({ data }))
    const ctx = await boot()
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    data = []
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })).rejects.toThrow(/discovery/i)
    expect((await ctx.llm.listModels('kimi-coding')).map(model => model.id)).toContain('new-kimi')
  })

  it('restores normalized metadata offline with owner-only cache files and no secrets', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'offline-kimi', system_prompt: 'DO NOT CACHE' }] }))
    const ctx = await boot()
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    await ctx.fiber.dispose()
    const home = homes[0]!
    const files = await readdir(join(home, 'cache', 'llm-pi-ai'))
    const metadataFile = files.find(file => file.endsWith('.json'))!
    const filename = join(home, 'cache', 'llm-pi-ai', metadataFile)
    const contents = await readFile(filename, 'utf8')
    expect(contents).not.toContain('metadata-test-key')
    expect(contents).not.toContain('DO NOT CACHE')
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o600)
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const restarted = await boot(home)
    await vi.waitFor(async () => {
      expect((await restarted.llm.listModels('kimi-coding')).map(model => model.id)).toContain('offline-kimi')
    })
  })

  it('coalesces concurrent refreshes, and cancelling one waiter leaves the other caller running', async () => {
    const entered = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<Response>()
    let count = 0
    vi.stubGlobal('fetch', async () => { count++; entered.resolve(undefined); return response.promise })
    const ctx = await boot()
    await entered.promise
    const signal = new AbortController()
    const cancelled = ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' }, signal.signal)
    const shared = ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    signal.abort()
    await expect(cancelled).rejects.toThrow(/aborted/)
    response.resolve(Response.json({ data: [{ id: 'single-flight' }] }))
    expect((await shared).map(model => model.id)).toContain('single-flight')
    expect(count).toBe(1)
  })

  it('fences a late old-account result after a credential update', async () => {
    const entered = Promise.withResolvers<undefined>()
    const oldResponse = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', async (_url: URL, options: RequestInit) => {
      if (new Headers(options.headers).get('authorization') === 'Bearer metadata-test-key') {
        entered.resolve(undefined)
        return oldResponse.promise
      }
      return Response.json({ data: [{ id: 'new-account-model' }] })
    })
    const ctx = await boot()
    await entered.promise
    await ctx.credentials.set(credentialRef('KIMI_DISCOVERY_TEST_KEY'), 'rotated-key')
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    oldResponse.resolve(Response.json({ data: [{ id: 'old-account-model' }] }))
    await ctx.fiber.dispose()
    const files = await readdir(join(homes[0]!, 'cache', 'llm-pi-ai'))
    const persisted = await Promise.all(files.map(file => readFile(join(homes[0]!, 'cache', 'llm-pi-ai', file), 'utf8')))
    expect(persisted.join()).toContain('new-account-model')
    expect(persisted.join()).not.toContain('old-account-model')
  })

  it('aborts outstanding body reads and waits for them during disposal', async () => {
    const entered = Promise.withResolvers<undefined>()
    let cancelled = false
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); entered.resolve(undefined) },
      cancel() { cancelled = true },
    })))
    const ctx = await boot()
    await entered.promise
    await ctx.fiber.dispose()
    expect(cancelled).toBe(true)
    await expect(readdir(join(homes[0]!, 'cache', 'llm-pi-ai'))).rejects.toThrow()
  })

  it('times out a stalled provider and preserves the configured model', async () => {
    vi.stubGlobal('fetch', async (_url: URL, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () =>{  reject(new Error('aborted')) }, { once: true })
    }))
    const ctx = await boot(undefined, { modelDiscovery: { enabled: true, timeoutMs: 20 } })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })).rejects.toThrow(/discovery/)
    expect((await ctx.llm.listModels('kimi-coding')).map(model => model.id)).toEqual(['kimi-for-coding'])
  })

  it('does no automatic network work when discovery is disabled', async () => {
    let count = 0
    vi.stubGlobal('fetch', async () => { count++; return Response.json({ data: [{ id: 'unexpected' }] }) })
    const ctx = await boot(undefined, { modelDiscovery: { enabled: false } })
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    expect((await ctx.llm.listModels('kimi-coding')).map(model => model.id)).toEqual(['kimi-for-coding'])
    expect(count).toBe(0)
  })

  it('keeps draft endpoint probes from changing the active catalog', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'active-model' }] }))
    const ctx = await boot()
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'draft-model' }] }))
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding', baseURL: 'https://draft.example/v1', apiKey: 'draft-key' })
    expect((await ctx.llm.listModels('kimi-coding')).map(model => model.id)).not.toContain('draft-model')
  })

  it('notifies existing catalog consumers only after a successful publication', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'first' }] }))
    const ctx = await boot()
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    let notifications = 0
    ctx.on('llm/adapters-updated', () => { notifications++ })
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'second' }] }))
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    expect(notifications).toBe(1)
    vi.stubGlobal('fetch', async () => Response.json({ data: [] }))
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })).rejects.toThrow()
    expect(notifications).toBe(1)
  })

  it('refreshes on the configured cadence and stops periodic work at disposal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let count = 0
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: `periodic-${++count}` }] }))
    const ctx = await boot(undefined, { modelDiscovery: { enabled: true, refreshIntervalMs: 1000 } })
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    await vi.advanceTimersByTimeAsync(1000)
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    expect((await ctx.llm.listModels('kimi-coding')).map(model => model.id)).toContain('periodic-2')
    await ctx.fiber.dispose()
    const stoppedAt = count
    await vi.advanceTimersByTimeAsync(10000)
    expect(count).toBe(stoppedAt)
  })

  it('adds new OpenAI API IDs using the route protocol without inventing their capabilities', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'brand-new-api-model' }] }))
    const ctx = await boot(undefined, { modelDiscovery: { enabled: false } })
    await ctx.settings.update('llm-pi-ai', { providers: { openai: {
      apiKeyEnv: 'KIMI_DISCOVERY_TEST_KEY', modelDiscovery: { enabled: true },
    } } })
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })
    const resolved = await ctx.llm.resolveModelInfo('openai', 'brand-new-api-model')
    expect(resolved.inputModalities).toEqual(['text'])
    expect(resolved.reasoning).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
  })

  it('refreshes expired OAuth through the serialized store before fetching model metadata', async () => {
    const ctx = await boot(undefined, { modelDiscovery: { enabled: false } })
    await ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor('anthropic'), async () => ({
      kind: 'grant', payload: { type: 'oauth', access: 'sk-ant-oat-expired', refresh: 'fake-refresh', expires: 1 },
    }))
    let refreshes = 0
    vi.stubGlobal('fetch', async (input: URL | string, options: RequestInit) => {
      const url = new URL(input)
      if (url.pathname.endsWith('/oauth/token')) {
        refreshes++
        return Response.json({ access_token: 'sk-ant-oat-rotated', refresh_token: 'fake-rotated-refresh', expires_in: 3600 })
      }
      expect(new Headers(options.headers).get('authorization')).toBe('Bearer sk-ant-oat-rotated')
      return Response.json({ data: [{ id: 'oauth-new-claude' }] })
    })
    await ctx.settings.update('llm-pi-ai', { providers: { anthropic: { modelDiscovery: { enabled: true } } } })
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'anthropic' })
    expect((await ctx.llm.listModels('anthropic')).map(model => model.id)).toContain('oauth-new-claude')
    expect(refreshes).toBe(1)
  })

  it('keeps explicit unknown-model compatibility and output defaults above live metadata', () => {
    const profiles = resolveProfiles({ anthropic: {
      modelDiscovery: { enabled: true },
      models: [{ id: 'claude-fable', maxTokens: 10000, reasoningEfforts: { high: 'high' }, compat: { forceAdaptiveThinking: true } }],
    } }, new Map([['anthropic', [{ id: 'claude-fable', maxTokens: 20000, reasoningEfforts: { low: 'low' } }]]]))
    const route = profiles.get('anthropic')!
    expect(route.piProvider.getModels()[0]).toMatchObject({
      id: 'claude-fable', maxTokens: 10000, compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { high: 'high', low: null, off: null },
    })
    expect(route.configuredMaxTokens.get('claude-fable')).toBe(10000)
  })

  it('fences an old endpoint response after configuration changes', async () => {
    const entered = Promise.withResolvers<undefined>()
    const oldResponse = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', async (url: URL) => {
      if (url.hostname === 'api.kimi.com') { entered.resolve(undefined); return oldResponse.promise }
      return Response.json({ data: [{ id: 'new-endpoint-model' }] })
    })
    const ctx = await boot()
    await entered.promise
    await ctx.settings.update('llm-pi-ai', { providers: { 'kimi-coding': { baseURL: 'https://new-endpoint.example' } } })
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    oldResponse.resolve(Response.json({ data: [{ id: 'old-endpoint-model' }] }))
    const listed = await ctx.llm.listModels('kimi-coding')
    expect(listed.map(model => model.id)).toContain('new-endpoint-model')
    expect(listed.map(model => model.id)).not.toContain('old-endpoint-model')
    await ctx.fiber.dispose()
  })

  it('applies the entry limit to retained metadata across refreshes', async () => {
    let prefix = 'first'
    vi.stubGlobal('fetch', async () => Response.json({ data: Array.from({ length: 1100 }, (_, index) => ({ id: `${prefix}-${index}` })) }))
    const ctx = await boot()
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })
    prefix = 'second'
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'kimi-coding' })).rejects.toThrow(/discovery/)
    expect((await ctx.llm.listModels('kimi-coding')).map(model => model.id)).not.toContain('second-0')
  })
})
