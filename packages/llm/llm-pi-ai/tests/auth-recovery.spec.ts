import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { recordKeyFor } from '../src/auth.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const UNAUTHORIZED = { status: 401, body: JSON.stringify({ error: { message: 'HTTP 401: token rejected' } }) }

/** Header snapshot search: the header carrying the bearer token varies by provider. */
function headerText(headers: Record<string, unknown>[]): string[] {
  return headers.map(h => JSON.stringify(h))
}

/** Resolve a fetch input to its URL string; a Request's default stringification is useless. */
function requestUrl(input: RequestInfo | URL): string {
  return input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
}

beforeEach(() => {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await closeMockServers()
})

async function harness(
  baseURL: string,
  overrides: Record<string, unknown> = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const LlmPiAi = await import('@deepseek-ai/dsh-llm-pi-ai')
  await ctx.plugin(LlmPiAi, {
    providers: { deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL, ...overrides } },
  })
  return ctx
}

describe('PiAiAdapter auth recovery', () => {
  it('retries a pre-content auth rejection and succeeds transparently', async () => {
    const server = await mockServer([UNAUTHORIZED, { events: textEvents }])
    const ctx = await harness(server.url, { authRecovery: { delayMs: 1 } })

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.paths).toEqual(['/chat/completions', '/chat/completions'])
  })

  it('surfaces AUTH after the recovery budget is spent', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const ctx = await harness(server.url, { authRecovery: { delayMs: 1 } })

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toEqual(['/chat/completions', '/chat/completions'])
  })

  it('keeps auth failures fatal when recovery is disabled', async () => {
    const server = await mockServer([UNAUTHORIZED, { events: textEvents }])
    const ctx = await harness(server.url, { authRecovery: { retries: 0, delayMs: 1 } })

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('honors a multi-attempt recovery budget', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED, { events: textEvents }])
    const ctx = await harness(server.url, { authRecovery: { retries: 2, delayMs: 1 } })

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toHaveLength(3)
  })

  it('does not retry a pre-content failure that is not an auth rejection', async () => {
    // A truncated stream classifies TRANSPORT; recovery must leave every
    // non-auth failure to the turn-level retry policy.
    const server = await mockServer([
      { events: ['{"choices":[{"delta":{"content":"hel"},"index":0,"finish_reason":null}]}'] },
      { events: textEvents },
    ])
    const ctx = await harness(server.url, { authRecovery: { delayMs: 1 } })

    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'TRANSPORT' } })
    expect(server.paths).toEqual(['/chat/completions'])
  })

  it('captures the credential produced by request-time OAuth refresh', async () => {
    const server = await mockServer([{ events: textEvents }])
    const auth = memoryAuth({
      anthropic: { type: 'oauth', access: 'expired-access', refresh: 'expired-refresh', expires: 0 },
    })
    const realFetch = globalThis.fetch
    const tokenFetch = vi.fn()
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (!requestUrl(input).includes('platform.claude.com')) return realFetch(input, init)
      tokenFetch()
      return Promise.resolve(new Response(JSON.stringify({
        access_token: 'request-access', refresh_token: 'request-refresh', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles({ anthropic: { baseURL: server.url + '/v1' } }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
    }))

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'TRANSPORT' } })
    expect(tokenFetch).toHaveBeenCalledOnce()
    expect(headerText(server.headers)).toEqual([expect.stringContaining('request-access')])
    expect(auth.stored.get('anthropic')).toMatchObject({ type: 'oauth', access: 'request-access' })
  })

  it('refreshes a stored OAuth credential once and retries with the rotated token', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const auth = memoryAuth({
      anthropic: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3_600_000 },
    })
    const tokenCalls: Record<string, string>[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('platform.claude.com')) {
        // The double posts a JSON string; BodyInit also admits streams and blobs.
        const body = init?.body
        if (typeof body !== 'string') throw new Error('auth-recovery double expects a string token-request body')
        tokenCalls.push(JSON.parse(body) as Record<string, string>)
        return new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return realFetch(input, init)
    })
    const observed: { provider: string; refreshed: boolean; error?: string }[] = []
    const providers: Record<string, PiAiProviderProfile> = {
      anthropic: { baseURL: server.url + '/v1', authRecovery: { delayMs: 1 } },
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles(providers),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      onAuthRecovery: (detail) => { observed.push(detail) },
    }))

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(tokenCalls).toEqual([expect.objectContaining({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
    })])
    expect(auth.stored.get('anthropic')).toEqual(expect.objectContaining({
      access: 'new-access',
      refresh: 'new-refresh',
    }))
    expect(observed).toEqual([{ provider: 'anthropic', refreshed: true }])
    const seen = headerText(server.headers)
    expect(seen[0]).toContain('old-access')
    expect(seen[1]).toContain('new-access')
  })

  it('skips a redundant refresh after another recovery rotates the failed credential', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const auth = memoryAuth({
      anthropic: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3_600_000 },
    })
    const rotated = { type: 'oauth' as const, access: 'other-access', refresh: 'other-refresh', expires: Date.now() + 3_600_000 }
    const modify = auth.credentials.modify.bind(auth.credentials)
    auth.credentials.modify = (id, mutate) => {
      auth.stored.set(id, rotated)
      return modify(id, mutate)
    }
    const tokenFetch = vi.fn()
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).includes('platform.claude.com')) {
        tokenFetch()
        return Promise.resolve(new Response('unexpected refresh', { status: 500 }))
      }
      return realFetch(input, init)
    })
    const observed: { provider: string; refreshed: boolean; error?: string }[] = []
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles({ anthropic: { baseURL: server.url + '/v1', authRecovery: { delayMs: 1 } } }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      onAuthRecovery: (detail) => { observed.push(detail) },
    }))

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(tokenFetch).not.toHaveBeenCalled()
    expect(auth.stored.get('anthropic')).toEqual(rotated)
    expect(observed).toEqual([{ provider: 'anthropic', refreshed: false }])
  })

  it('does not rotate stored OAuth when an API key override was rejected', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const auth = memoryAuth({
      anthropic: { type: 'oauth', access: 'stored-access', refresh: 'stored-refresh', expires: Date.now() + 3_600_000 },
    })
    const modify = vi.spyOn(auth.credentials, 'modify')
    const observed: { provider: string; refreshed: boolean; error?: string }[] = []
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles({ anthropic: { baseURL: server.url + '/v1', authRecovery: { delayMs: 1 } } }),
      resolveApiKey: () => Promise.resolve('static-api-key'),
      auth,
      onAuthRecovery: (detail) => { observed.push(detail) },
    }))

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(modify).not.toHaveBeenCalled()
    expect(headerText(server.headers)).toEqual(expect.arrayContaining([
      expect.stringContaining('static-api-key'),
    ]))
    expect(observed).toEqual([{ provider: 'anthropic', refreshed: false }])
  })

  it('does not rotate stored auth when a keyless catalog route has no OAuth flow', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const auth = memoryAuth({ deepseek: { type: 'api_key', key: 'stored-key' } })
    const observed: { provider: string; refreshed: boolean; error?: string }[] = []
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['deepseek'], new PiAiAdapter({
      profiles: () => resolveProfiles({ deepseek: { baseURL: server.url, authRecovery: { delayMs: 1 } } }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      onAuthRecovery: (detail) => { observed.push(detail) },
    }))

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(headerText(server.headers)).toEqual([
      expect.stringContaining('stored-key'),
      expect.stringContaining('stored-key'),
    ])
    expect(observed).toEqual([{ provider: 'deepseek', refreshed: false }])
  })

  it('bounds credential-store serialization with the stream idle timeout', async () => {
    const server = await mockServer([UNAUTHORIZED])
    const auth = memoryAuth({
      anthropic: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3_600_000 },
    })
    const modify = vi.fn(auth.credentials.modify.bind(auth.credentials))
    auth.credentials.modify = (id, mutate, options) => new Promise((resolve, reject) => {
      const signal = options?.signal
      if (signal === undefined) {
        resolve(modify(id, mutate, options))
        return
      }
      const aborted = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('credential modification aborted'))
      }
      if (signal.aborted) aborted()
      else signal.addEventListener('abort', aborted, { once: true })
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles({
        anthropic: { baseURL: server.url + '/v1', streamIdleTimeoutMs: 20, authRecovery: { delayMs: 1 } },
      }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
    }))

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'TIMEOUT' } })
    expect(server.paths).toHaveLength(1)
    expect(modify).not.toHaveBeenCalled()
  })

  it('bounds a stalled OAuth refresh with the stream idle timeout', async () => {
    const server = await mockServer([UNAUTHORIZED])
    const auth = memoryAuth({
      anthropic: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3_600_000 },
    })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (!requestUrl(input).includes('platform.claude.com')) return realFetch(input, init)
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const aborted = (): void => {
          reject(signal?.reason instanceof Error ? signal.reason : new Error('auth recovery aborted'))
        }
        if (signal?.aborted) aborted()
        else signal?.addEventListener('abort', aborted, { once: true })
      })
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles({
        anthropic: {
          baseURL: server.url + '/v1',
          streamIdleTimeoutMs: 250,
          authRecovery: { delayMs: 1 },
        },
      }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
    }))

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'TIMEOUT' } })
    expect(server.paths).toHaveLength(1)
  })

  it('retries with the current credential when the forced refresh fails', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const auth = memoryAuth({
      anthropic: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3_600_000 },
    })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      requestUrl(input).includes('platform.claude.com')
        ? Promise.resolve(new Response('token endpoint down', { status: 500 }))
        : realFetch(input, init))
    const observed: { provider: string; refreshed: boolean; error?: string }[] = []
    const providers: Record<string, PiAiProviderProfile> = {
      anthropic: { baseURL: server.url + '/v1', authRecovery: { delayMs: 1 } },
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles(providers),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      onAuthRecovery: (detail) => { observed.push(detail) },
    }))

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toHaveLength(2)
    expect(auth.stored.get('anthropic')).toEqual(expect.objectContaining({ access: 'old-access' }))
    expect(observed).toEqual([expect.objectContaining({ provider: 'anthropic', refreshed: false })])
    expect(observed[0]?.error).toMatch(/500/)
  })

  it('aborts the caller during the recovery delay instead of retrying', async () => {
    const server = await mockServer([UNAUTHORIZED, { events: textEvents }])
    const ctx = await harness(server.url, { authRecovery: { delayMs: 5_000 } })
    const controller = new AbortController()
    const pending = assemble(ctx, { model: 'deepseek-v4-flash', messages: [], signal: controller.signal })
    await vi.waitFor(() => {
      expect(server.paths).toHaveLength(1)
    })
    controller.abort()

    const result = await pending

    expect(result.finish).toMatchObject({ kind: 'aborted' })
    expect(server.paths).toHaveLength(1)
  })

  it('retries without a refresh when the stored credential is not OAuth', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const auth = memoryAuth({
      anthropic: { type: 'api_key', key: 'sk-old' },
    })
    const observed: { provider: string; refreshed: boolean; error?: string }[] = []
    const providers: Record<string, PiAiProviderProfile> = {
      anthropic: { baseURL: server.url + '/v1', authRecovery: { delayMs: 1 } },
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles(providers),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      onAuthRecovery: (detail) => { observed.push(detail) },
    }))

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toHaveLength(2)
    expect(auth.stored.get('anthropic')).toEqual({ type: 'api_key', key: 'sk-old' })
    expect(observed).toEqual([{ provider: 'anthropic', refreshed: false }])
  })

  it('skips the recovery delay when its observer aborts the caller', async () => {
    const server = await mockServer([UNAUTHORIZED, { events: textEvents }])
    const auth = memoryAuth({
      anthropic: { type: 'api_key', key: 'sk-old' },
    })
    const controller = new AbortController()
    const observed: { provider: string; refreshed: boolean; error?: string }[] = []
    const providers: Record<string, PiAiProviderProfile> = {
      anthropic: { baseURL: server.url + '/v1', authRecovery: { delayMs: 5_000 } },
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles(providers),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      onAuthRecovery: (detail) => {
        observed.push(detail)
        controller.abort()
      },
    }))

    const result = await assemble(ctx, {
      provider: 'anthropic', model: 'claude-fable-5', messages: [], signal: controller.signal,
    })

    expect(result.finish).toMatchObject({ kind: 'aborted' })
    expect(server.paths).toHaveLength(1)
    expect(observed).toEqual([{ provider: 'anthropic', refreshed: false }])
  })

  it('aborts before the recovery delay when cancellation lands during the refresh', async () => {
    const server = await mockServer([UNAUTHORIZED, { events: textEvents }])
    const auth = memoryAuth({
      anthropic: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3_600_000 },
    })
    let releaseRefresh: ((error: Error) => void) | undefined
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      requestUrl(input).includes('platform.claude.com')
        ? new Promise<Response>((_resolve, reject) => { releaseRefresh = reject })
        : realFetch(input, init))
    const providers: Record<string, PiAiProviderProfile> = {
      anthropic: { baseURL: server.url + '/v1', authRecovery: { delayMs: 5_000 } },
    }
    const observed: { provider: string; refreshed: boolean; error?: string }[] = []
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles(providers),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      onAuthRecovery: (detail) => { observed.push(detail) },
    }))
    const controller = new AbortController()
    const pending = assemble(ctx, {
      provider: 'anthropic',
      model: 'claude-fable-5',
      messages: [],
      signal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(server.paths).toHaveLength(1)
    })
    controller.abort()
    releaseRefresh?.(new Error('caller went away'))

    const result = await pending

    expect(result.finish).toMatchObject({ kind: 'aborted' })
    expect(server.paths).toHaveLength(1)
    expect(observed).toEqual([])
  })

  it('reports a non-Error refresh failure through the observer', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const auth = memoryAuth({
      anthropic: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3_600_000 },
    })
    // The adapter must survive and report a credential-store failure that is not an Error.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection IS the scenario under test
    auth.credentials.modify = () => Promise.reject('plain string failure')
    const observed: { provider: string; refreshed: boolean; error?: string }[] = []
    const providers: Record<string, PiAiProviderProfile> = {
      anthropic: { baseURL: server.url + '/v1', authRecovery: { delayMs: 1 } },
    }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
      profiles: () => resolveProfiles(providers),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      onAuthRecovery: (detail) => { observed.push(detail) },
    }))

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(observed).toEqual([{ provider: 'anthropic', refreshed: false, error: 'plain string failure' }])
  })
})

describe('auth recovery through the plugin composition', () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  /** The plugin mounted over a real credential store holding one Anthropic OAuth grant. */
  async function oauthHarness(baseURL: string): Promise<Context> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-recovery-'))
    dirs.push(dir)
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.plugin(LlmRuntime)
    const LlmPiAi = await import('@deepseek-ai/dsh-llm-pi-ai')
    await ctx.plugin(LlmPiAi, {
      providers: { anthropic: { baseURL: baseURL + '/v1', authRecovery: { delayMs: 1 } } },
    })
    await ctx.credentials.modifyRecord(recordKeyFor('anthropic'), () => Promise.resolve({
      kind: 'grant',
      payload: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + 3_600_000 },
    }))
    return ctx
  }

  it('persists the rotated credential the plugin store refresh produces', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      requestUrl(input).includes('platform.claude.com')
        ? Promise.resolve(new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        : realFetch(input, init))
    const ctx = await oauthHarness(server.url)

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toHaveLength(2)
    await expect(ctx.credentials.readRecord(recordKeyFor('anthropic'))).resolves.toEqual({
      kind: 'grant',
      // objectContaining resolves to any; the assertion names the matched grant fields.
      payload: expect.objectContaining({ access: 'new-access', refresh: 'new-refresh' }) as {
        access: string
        refresh: string
      },
    })
  })

  it('retries with the current credential when the plugin store refresh fails', async () => {
    const server = await mockServer([UNAUTHORIZED, UNAUTHORIZED])
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      requestUrl(input).includes('platform.claude.com')
        ? Promise.resolve(new Response('token endpoint down', { status: 500 }))
        : realFetch(input, init))
    const ctx = await oauthHarness(server.url)

    const result = await assemble(ctx, { provider: 'anthropic', model: 'claude-fable-5', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toHaveLength(2)
    await expect(ctx.credentials.readRecord(recordKeyFor('anthropic'))).resolves.toEqual({
      kind: 'grant',
      // objectContaining resolves to any; the assertion names the matched grant field.
      payload: expect.objectContaining({ access: 'old-access' }) as { access: string },
    })
  })
})
