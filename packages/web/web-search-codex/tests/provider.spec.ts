import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { WebError } from '@deepseek-ai/dsh-web'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import { CODEX_SEARCH_PROVIDER_ID, CodexSearchProvider } from '../src/provider.ts'

type JsonObject = Record<string, unknown>

function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>()
}

interface FakeAppServer {
  readonly child: SubprocessHandle
  readonly peer: JsonRpcLineTransport
  readonly requests: Array<{ method: string; params: JsonObject }>
  readonly terminate: ReturnType<typeof vi.fn>
}

function fakeAppServer(
  handle: (method: string, params: JsonObject, peer: JsonRpcLineTransport) => unknown,
): FakeAppServer {
  const providerInput = new PassThrough()
  const providerOutput = new PassThrough()
  const peer = new JsonRpcLineTransport(providerOutput, providerInput)
  const requests: Array<{ method: string; params: JsonObject }> = []
  peer.onRequest(async (method, params) => {
    requests.push({ method, params })
    return await handle(method, params, peer)
  })
  peer.start()
  const exit = deferred<SubprocessOutcome>()
  const terminate = vi.fn(() => { exit.resolve({ exitCode: 0, signal: null }) })
  const child: SubprocessHandle = {
    pid: 42,
    stdin: providerOutput,
    stdout: providerInput,
    stderr: new PassThrough(),
    collected: {},
    done: exit.promise,
    terminate,
    waitForExit: vi.fn(async () => { await exit.promise; return true }),
  }
  return { child, peer, requests, terminate }
}

function provider(
  server: FakeAppServer,
  spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => server.child),
): {
  readonly value: CodexSearchProvider
  readonly spawn: typeof spawn
} {
  const ctx = { subprocess: { spawn } } as unknown as Context
  return {
    value: new CodexSearchProvider(ctx, { cwd: '/workspace', graceMs: 25 }),
    spawn,
  }
}

function successfulServer(): FakeAppServer {
  return fakeAppServer((method, _params, peer) => {
    if (method === 'initialize') return {}
    if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
    if (method === 'turn/start') {
      peer.notify('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1,
        item: {
          type: 'webSearch', id: 'search-1', query: 'one', action: null,
          results: [
            { url: 'https://good.test/a', title: 'Good', snippet: 'Snippet', published_at: '2026-01-01' },
            { url: 'https://blocked.test/a', title: 'Blocked' },
            { url: 'file:///private', title: 'File' },
            null,
            1,
            [],
            {},
            { url: '' },
            { url: 1 },
            { url: 'not a url' },
            { url: 'https://blocked.test/minimal', title: '', snippet: '', publishedAt: '' },
          ],
        },
      })
      peer.notify('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 2,
        item: {
          type: 'webSearch', id: 'search-2', query: 'two', action: null,
          results: [{ url: 'https://sub.good.test/b', publishedAt: '2026-02-02' }],
        },
      })
      peer.notify('turn/completed', {
        threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
      })
      return { turn: { id: 'turn-1' } }
    }
    if (method === 'turn/interrupt') return {}
    throw new Error(`unexpected method ${method}`)
  })
}

describe('CodexSearchProvider', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('uses one official process/thread/turn and expands duplicate queries positionally', async () => {
    const server = successfulServer()
    const instance = provider(server)
    const outcomes = await instance.value.searchMany({
      queries: ['one', 'two', 'one'],
      mode: 'live',
      allowedDomains: ['.', 'good.test', 'blocked.test'],
      blockedDomains: ['blocked.test'],
      location: { country: 'US', city: 'Seattle' },
    })

    expect(instance.value.id).toBe(CODEX_SEARCH_PROVIDER_ID)
    expect(instance.spawn).toHaveBeenCalledOnce()
    expect(instance.spawn.mock.calls[0]?.[0]).toMatchObject({
      argv: [process.execPath, expect.stringContaining('@openai/codex'), 'app-server', '--stdio'],
      cwd: '/workspace', graceMs: 25,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    expect(server.requests.map(request => request.method)).toEqual([
      'initialize', 'thread/start', 'turn/start',
    ])
    const thread = server.requests[1]?.params
    expect(thread).toMatchObject({
      cwd: '/workspace', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
      config: {
        web_search: 'live',
        tools: { web_search: true },
      },
    })
    const turn = server.requests[2]?.params
    expect(turn).toMatchObject({ threadId: 'thread-1' })
    const turnJson = JSON.stringify(turn)
    expect(turnJson).toContain(String.raw`Use sources only from these allowed domains: [\".\",\"good.test\",\"blocked.test\"]`)
    expect(turnJson).toContain(String.raw`Do not use sources from these blocked domains: [\"blocked.test\"]`)
    expect(turnJson).toContain(String.raw`Prefer results relevant to this user location: {\"country\":\"US\",\"city\":\"Seattle\"}`)
    expect(turnJson).toContain(String.raw`Queries: [\"one\",\"two\"]`)
    expect(outcomes).toEqual([
      {
        query: 'one',
        result: {
          sources: [{
            url: 'https://good.test/a', title: 'Good', snippet: 'Snippet', publishedAt: '2026-01-01',
          }],
          truncated: false,
        },
      },
      {
        query: 'two',
        result: {
          sources: [{ url: 'https://sub.good.test/b', publishedAt: '2026-02-02' }],
          truncated: false,
        },
      },
      {
        query: 'one',
        result: {
          sources: [{
            url: 'https://good.test/a', title: 'Good', snippet: 'Snippet', publishedAt: '2026-01-01',
          }],
          truncated: false,
        },
      },
    ])
    expect(server.terminate).toHaveBeenCalledOnce()
  })

  it('returns safe partial protocol failures for missing, duplicate, and malformed items', async () => {
    const server = fakeAppServer((method, _params, peer) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        for (const item of [
          { type: 'webSearch', id: 'a', query: 'one', action: null, results: [] },
          { type: 'webSearch', id: 'b', query: 'one', action: null, results: [] },
          { type: 'webSearch', id: 'c', query: 2, action: null, results: [] },
          { type: 'webSearch', id: 'd', query: 'other', action: null, results: [] },
          { type: 'agentMessage', id: 'e', text: 'ignore prose', phase: 'final_answer' },
        ]) peer.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item })
        peer.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        return { turn: { id: 'turn-1' } }
      }
      return {}
    })
    const instance = provider(server).value
    const outcomes = await instance.searchMany({ queries: ['one', 'two'] })
    expect(outcomes.map(outcome => [outcome.query, outcome.error?.code])).toEqual([
      ['one', 'WEB_PROVIDER_PROTOCOL'],
      ['two', 'WEB_PROVIDER_PROTOCOL'],
    ])
  })

  it('maps unknown protocol failures safely without retrying', async () => {
    const server = fakeAppServer((method) => {
      if (method === 'initialize') throw new Error('private app-server detail')
      return {}
    })
    const instance = provider(server)
    await expect(instance.value.searchMany({ queries: ['q'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Codex web search provider failed' }),
    )
    expect(instance.spawn).toHaveBeenCalledOnce()
  })

  it('rejects spawn and missing protocol-pipe failures safely', async () => {
    const server = successfulServer()
    const throwingSpawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => {
      throw new Error('private spawn detail')
    })
    await expect(provider(server, throwingSpawn).value.searchMany({ queries: ['q'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )

    for (const child of [
      { ...server.child, stdin: undefined },
      { ...server.child, stdout: undefined },
    ]) {
      const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => child)
      await expect(provider(server, spawn).value.searchMany({ queries: ['q'] })).rejects.toThrow(
        expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
      )
    }
  })

  it.each([
    ['exit', () => Promise.resolve<SubprocessOutcome>({ exitCode: 7, signal: null })],
    ['error', () => Promise.reject(new Error('private process detail'))],
  ] as const)('maps %s process settlement before the turn safely', async (_label, createDone) => {
    const done = createDone()
    void done.catch(() => {})
    const server = successfulServer()
    const child = { ...server.child, done }
    const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => child)
    await expect(provider(server, spawn).value.searchMany({ queries: ['q'] })).rejects.toBeInstanceOf(WebError)
  })

  it('aggregates successful-run stdin, wait, and outcome teardown failures', async () => {
    const server = successfulServer()
    const exit = deferred<SubprocessOutcome>()
    const stdin = server.child.stdin
    if (stdin === undefined) throw new Error('expected fake stdin')
    const end = vi.spyOn(stdin, 'end').mockImplementation(() => { throw new Error('private stdin detail') })
    const child: SubprocessHandle = {
      ...server.child,
      done: exit.promise,
      terminate: () => { exit.reject(new Error('private done detail')) },
      waitForExit: async () => { throw new Error('private wait detail') },
    }
    const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => child)
    await expect(provider(server, spawn).value.searchMany({ queries: ['one'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Codex web search cleanup failed' }),
    )
    expect(end).toHaveBeenCalledOnce()
  })

  it('preserves a primary provider failure when teardown also fails', async () => {
    const server = fakeAppServer((method) => {
      if (method === 'initialize') throw new Error('private protocol detail')
      return {}
    })
    const child = {
      ...server.child,
      waitForExit: vi.fn<SubprocessHandle['waitForExit']>(async () => { throw new Error('private wait detail') }),
    }
    const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => child)
    await expect(provider(server, spawn).value.searchMany({ queries: ['q'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Codex web search provider failed' }),
    )
  })

  it('interrupts and reaches process quiescence before cancellation rejects', async () => {
    const turnStarted = deferred<boolean>()
    const server = fakeAppServer((method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        turnStarted.resolve(true)
        return { turn: { id: 'turn-1' } }
      }
      if (method === 'turn/interrupt') return {}
      return {}
    })
    const instance = provider(server).value
    const controller = new AbortController()
    const pending = instance.searchMany({ queries: ['q'] }, controller.signal)
    await turnStarted.promise
    await vi.waitFor(() => {
      expect(server.requests.some(request => request.method === 'turn/start')).toBe(true)
    })
    controller.abort(new Error('cancelled by caller'))
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(server.terminate).toHaveBeenCalledOnce()
  })

  it('rethrows a one-item protocol failure without a result cap', async () => {
    const server = fakeAppServer((method, _params, peer) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        peer.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
        return { turn: { id: 'turn-1' } }
      }
      return {}
    })
    await expect(provider(server).value.search({ query: 'q' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_PROTOCOL' }),
    )
  })

  it('checks availability without spawning and supports one-item search', async () => {
    const server = successfulServer()
    const instance = provider(server)
    expect(instance.value.available()).toBe(true)
    expect(instance.spawn).not.toHaveBeenCalled()
    const result = await instance.value.search({ query: 'one', maxResults: 1 })
    expect(result.sources[0]).toMatchObject({ url: 'https://good.test/a' })
  })

  it('rejects pre-aborted calls before spawning', async () => {
    const server = successfulServer()
    const instance = provider(server)
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(instance.value.searchMany({ queries: ['q'] }, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
    expect(instance.spawn).not.toHaveBeenCalled()
  })
})

describe('Codex search plugin', () => {
  it('keeps function-plugin exports and registers the provider', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('web-search-codex')
    expect(plugin.inject).toEqual(['web', 'subprocess'])
    const registerSearchProvider = vi.fn()
    const ctx = { web: { registerSearchProvider } } as unknown as Context
    plugin.apply(ctx)
    plugin.apply(ctx, { cwd: '/workspace', graceMs: 1 })
    expect(registerSearchProvider).toHaveBeenCalledTimes(2)
    expect(registerSearchProvider.mock.calls[0]?.[0]).toBeInstanceOf(CodexSearchProvider)
  })

  it.each([
    [{ cwd: '' }, 'cwd'],
    [{ graceMs: 0 }, 'graceMs'],
    [{ graceMs: 1.5 }, 'graceMs'],
  ] as const)('rejects invalid direct config %#', (config, field) => {
    const ctx = { web: { registerSearchProvider: vi.fn() } } as unknown as Context
    let thrown: unknown
    try {
      plugin.apply(ctx, config)
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WebError)
    if (!(thrown instanceof WebError)) throw new Error('expected WebError')
    expect(thrown.code).toBe('WEB_INVALID_CONFIG')
    expect(thrown.message).toContain(field)
  })

  it('registers the package-owned invariant companion', async () => {
    const dispose = vi.fn()
    const register = vi.fn((_name: string, _installer: InvariantInstaller) => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    const install = register.mock.calls[0]?.[1]
    if (install === undefined) throw new Error('expected invariant installer')
    await install(new Context(), (message) => { throw new Error(message) })
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-web-search-codex', expect.any(Function))
  })
})
