import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { WebError } from '@deepseek-ai/dsh-web'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<typeof import('@anthropic-ai/claude-agent-sdk').query>(),
}))
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: queryMock,
}))

import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import {
  CLAUDE_CODE_SEARCH_PROVIDER_ID,
  ClaudeCodeSearchProvider,
} from '../src/provider.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function fakeChild(wait: Promise<void> = Promise.resolve()): SubprocessHandle & {
  terminate: ReturnType<typeof vi.fn>
  waitForExit: ReturnType<typeof vi.fn>
} {
  const outcome: SubprocessOutcome = { exitCode: 0, signal: null }
  const terminate = vi.fn<SubprocessHandle['terminate']>()
  const waitForExit = vi.fn<SubprocessHandle['waitForExit']>(() => wait.then(() => true))
  return {
    pid: 42,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: undefined,
    collected: {},
    done: wait.then(() => outcome),
    terminate,
    waitForExit,
  }
}

function fakeContext(child: SubprocessHandle): Context {
  return { subprocess: { spawn: vi.fn(() => child) } } as unknown as Context
}

function message(value: unknown): SDKMessage {
  return value as SDKMessage
}

function queryOf(messages: readonly SDKMessage[], close = vi.fn()): Query {
  return {
    close,
    async *[Symbol.asyncIterator]() {
      for (const item of messages) yield item
    },
  } as unknown as Query
}

function customQuery(iterate: () => AsyncGenerator<SDKMessage, void, unknown>): Query {
  return { close: vi.fn(), [Symbol.asyncIterator]: iterate } as unknown as Query
}

function raw(query: string, url: string): SDKMessage {
  return message({
    type: 'user',
    tool_use_result: {
      query,
      results: [{ tool_use_id: `tool-${query}`, content: [{ title: `Title ${query}`, url }] }],
      durationSeconds: 0.1,
    },
  })
}

function success(outcomes: unknown): SDKMessage {
  return message({ type: 'result', subtype: 'success', structured_output: { outcomes } })
}

describe('ClaudeCodeSearchProvider', () => {
  beforeEach(() => { queryMock.mockReset() })

  it('uses one official SDK session with only WebSearch and maps raw citations', async () => {
    const child = fakeChild()
    queryMock.mockImplementationOnce(({ options }) => {
      if (options?.abortController === undefined) throw new Error('expected SDK options')
      options.spawnClaudeCodeProcess?.({
        command: 'claude', args: [], cwd: '/workspace', env: {}, signal: options.abortController.signal,
      })
      return queryOf([
        raw('one', 'https://one.test/path'),
        raw('two', 'file:///not-http'),
        success([{ query: 'one', answer: 'answer one' }, { query: 'two', answer: 'answer two' }]),
      ])
    })
    const provider = new ClaudeCodeSearchProvider(fakeContext(child), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })

    const outcomes = await provider.searchMany({
      queries: ['one', 'two'],
      allowedDomains: ['one.test'],
      blockedDomains: ['blocked.test'],
      location: { country: 'US', city: 'Seattle' },
    })

    expect(provider.id).toBe(CLAUDE_CODE_SEARCH_PROVIDER_ID)
    expect(queryMock).toHaveBeenCalledTimes(1)
    const call = queryMock.mock.calls[0]?.[0]
    if (call === undefined) throw new Error('expected one SDK query call')
    expect(call.options).toMatchObject({
      cwd: '/workspace',
      tools: ['WebSearch'],
      allowedTools: ['WebSearch'],
      permissionMode: 'dontAsk',
      persistSession: false,
      maxTurns: 4,
      outputFormat: { type: 'json_schema' },
    })
    expect(call.options).not.toHaveProperty('fallbackModel')
    expect(call.prompt).toContain('allowed_domains=["one.test"]')
    expect(call.prompt).toContain('blocked_domains=["blocked.test"]')
    expect(call.prompt).toContain('Prefer results relevant to this user location: {"country":"US","city":"Seattle"}')
    expect(outcomes).toEqual([
      {
        query: 'one',
        result: {
          content: 'answer one',
          sources: [{ url: 'https://one.test/path', title: 'Title one' }],
          truncated: false,
        },
      },
      {
        query: 'two',
        result: {
          content: 'answer two',
          sources: [],
          truncated: false,
        },
      },
    ])
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('deduplicates provider work and enforces allowed and blocked citation domains', async () => {
    queryMock.mockReturnValueOnce(queryOf([
      message({
        type: 'user',
        tool_use_result: {
          query: 'same',
          results: [{
            tool_use_id: 'tool-same',
            content: [
              { title: 'Allowed', url: 'https://sub.good.test/path' },
              { title: 'Blocked', url: 'https://bad.test/path' },
              { title: 'Outside allowlist', url: 'https://other.test/path' },
              { title: 'Malformed', url: 'not a url' },
            ],
          }],
          durationSeconds: 0.1,
        },
      }),
      success([{ query: 'same', answer: 'grounded' }]),
    ]))
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    const outcomes = await provider.searchMany({
      queries: ['same', 'same'],
      allowedDomains: ['.', 'good.test', 'bad.test'],
      blockedDomains: ['bad.test'],
    })
    expect(queryMock.mock.calls[0]?.[0].prompt).toContain('Queries: ["same"]')
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]).toEqual(outcomes[1])
    expect(outcomes[0]?.result?.sources).toEqual([
      { url: 'https://sub.good.test/path', title: 'Allowed' },
    ])
  })

  it('ignores malformed raw tool payload fields while retaining valid URL-only citations', async () => {
    queryMock.mockReturnValueOnce(queryOf([
      message({ type: 'user', tool_use_result: null }),
      message({ type: 'user', tool_use_result: { query: 1, results: [] } }),
      message({ type: 'user', tool_use_result: { query: 'q', results: 'bad' } }),
      message({
        type: 'user',
        tool_use_result: {
          query: 'q',
          results: [
            'bad',
            { content: 'bad' },
            { content: ['bad', { url: 1 }, { url: 'https://valid.test/path' }] },
          ],
        },
      }),
      success([{ query: 'q' }]),
    ]))
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.searchMany({ queries: ['q'] })).resolves.toEqual([{
      query: 'q',
      result: { sources: [{ url: 'https://valid.test/path' }], truncated: false },
    }])
  })

  it.each([
    null,
    {},
    { outcomes: 'bad' },
    { outcomes: [] },
    { outcomes: [null] },
    { outcomes: [{ query: 'wrong' }] },
    { outcomes: [{ query: 'q', answer: 1 }] },
  ])('rejects malformed structured output %#', async (structuredOutput) => {
    queryMock.mockReturnValueOnce(queryOf([
      raw('q', 'https://q.test'),
      message({ type: 'result', subtype: 'success', structured_output: structuredOutput }),
    ]))
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.searchMany({ queries: ['q'] })).resolves.toMatchObject([{
      query: 'q', error: { code: 'WEB_PROVIDER_PROTOCOL' },
    }])
  })

  it('returns per-query protocol failures for missing or duplicate raw tool results', async () => {
    queryMock.mockReturnValueOnce(queryOf([
      raw('one', 'https://one.test'),
      raw('one', 'https://duplicate.test'),
      success([{ query: 'one' }, { query: 'two' }]),
    ]))
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.searchMany({ queries: ['one', 'two'] })).resolves.toEqual([
      {
        query: 'one',
        error: {
          code: 'WEB_PROVIDER_PROTOCOL',
          message: 'Claude Code returned incomplete structured web search data',
        },
      },
      {
        query: 'two',
        error: {
          code: 'WEB_PROVIDER_PROTOCOL',
          message: 'Claude Code returned incomplete structured web search data',
        },
      },
    ])
  })

  it('surfaces unexpected SDK and successful-run cleanup failures safely', async () => {
    queryMock.mockImplementationOnce(() => { throw new Error('private startup detail') })
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.searchMany({ queries: ['q'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Claude Code web search provider failed' }),
    )

    queryMock.mockReturnValueOnce(queryOf([
      raw('q', 'https://q.test'), success([{ query: 'q' }]),
    ], vi.fn(() => { throw new Error('private close detail') })))
    await expect(provider.searchMany({ queries: ['q'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Claude Code web search cleanup failed' }),
    )
  })

  it('contains teardown failures when a primary safe failure already exists', async () => {
    queryMock.mockReturnValueOnce(queryOf(
      [message({ type: 'result', subtype: 'error_during_execution' })],
      vi.fn(() => { throw new Error('private close detail') }),
    ))
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.searchMany({ queries: ['q'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Claude Code web search session failed' }),
    )
  })

  it('sanitizes SDK failure without retrying', async () => {
    queryMock.mockReturnValueOnce(queryOf([message({ type: 'result', subtype: 'error_during_execution' })]))
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.searchMany({ queries: ['private query'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Claude Code web search session failed' }),
    )
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('rejects pre-aborted calls without creating an SDK query', async () => {
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(provider.searchMany({ queries: ['q'] }, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('rejects duplicate SDK process spawns without retrying', async () => {
    const child = fakeChild()
    queryMock.mockImplementationOnce(({ options }) => {
      if (options?.abortController === undefined) throw new Error('expected SDK options')
      const spawn = {
        command: 'claude', args: [], cwd: '/workspace', env: {}, signal: options.abortController.signal,
      }
      options.spawnClaudeCodeProcess?.(spawn)
      options.spawnClaudeCodeProcess?.(spawn)
      return queryOf([])
    })
    const provider = new ClaudeCodeSearchProvider(fakeContext(child), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.searchMany({ queries: ['q'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }),
    )
    expect(queryMock).toHaveBeenCalledOnce()
  })

  it('maps an abort observed after a clean SDK iterator completion', async () => {
    const controller = new AbortController()
    queryMock.mockReturnValueOnce(customQuery(async function* () {
      controller.abort()
      if (false) yield message({ type: 'assistant' })
      return
    }))
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.searchMany({ queries: ['q'] }, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
  })

  it('aggregates managed wait and outcome failures after a successful SDK result', async () => {
    const done = Promise.reject(new Error('private done detail'))
    void done.catch(() => {})
    const base = fakeChild()
    const child = {
      ...base,
      done,
      waitForExit: vi.fn<SubprocessHandle['waitForExit']>(async () => { throw new Error('private wait detail') }),
    }
    queryMock.mockImplementationOnce(({ options }) => {
      if (options?.abortController === undefined) throw new Error('expected SDK options')
      options.spawnClaudeCodeProcess?.({
        command: 'claude', args: [], cwd: '/workspace', env: {}, signal: options.abortController.signal,
      })
      return queryOf([raw('q', 'https://q.test'), success([{ query: 'q' }])])
    })
    const provider = new ClaudeCodeSearchProvider(fakeContext(child), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.searchMany({ queries: ['q'] })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Claude Code web search cleanup failed' }),
    )
  })

  it('aborts the SDK and waits for process-tree cleanup before rejecting', async () => {
    const cleanup = deferred<true>()
    const child = fakeChild(cleanup.promise.then(() => {}))
    let sdkSignal: AbortSignal | undefined
    queryMock.mockImplementationOnce(({ options }) => {
      if (options?.abortController === undefined) throw new Error('expected SDK options')
      sdkSignal = options.abortController.signal
      options.spawnClaudeCodeProcess?.({
        command: 'claude', args: [], cwd: '/workspace', env: {}, signal: sdkSignal,
      })
      return customQuery(async function* () {
        await new Promise<void>((resolve) => {
          sdkSignal?.addEventListener('abort', () => { resolve() }, { once: true })
        })
        throw new Error('private SDK cancellation detail')
      })
    })
    const provider = new ClaudeCodeSearchProvider(fakeContext(child), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    const controller = new AbortController()
    let settled = false
    const pending = provider.searchMany({ queries: ['q'] }, controller.signal)
      .finally(() => { settled = true })
    await vi.waitFor(() => { expect(sdkSignal).toBeDefined() })
    controller.abort(new Error('caller cancelled'))
    await vi.waitFor(() => { expect(sdkSignal?.aborted).toBe(true) })
    await vi.waitFor(() => { expect(child.terminate).toHaveBeenCalledOnce() })
    expect(settled).toBe(false)
    cleanup.resolve(true)
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('checks availability without starting an SDK query or process', () => {
    const spawn = vi.fn()
    const provider = new ClaudeCodeSearchProvider(
      { subprocess: { spawn } } as unknown as Context,
      { cwd: '/workspace', graceMs: 10, maxTurns: 4 },
    )
    expect(provider.available()).toBe(true)
    expect(queryMock).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns a successful one-item search with a caller result cap', async () => {
    queryMock.mockReturnValueOnce(queryOf([raw('q', 'https://q.test'), success([{ query: 'q' }])]))
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.search({ query: 'q', maxResults: 1 })).resolves.toMatchObject({
      sources: [{ url: 'https://q.test', title: 'Title q' }],
    })
  })

  it('rethrows one-item safe failures from search()', async () => {
    queryMock.mockReturnValueOnce(queryOf([success([{ query: 'q' }])]))
    const provider = new ClaudeCodeSearchProvider(fakeContext(fakeChild()), {
      cwd: '/workspace', graceMs: 10, maxTurns: 4,
    })
    await expect(provider.search({ query: 'q' })).rejects.toBeInstanceOf(WebError)
  })
})


describe('Claude Code search plugin', () => {
  it('keeps the Loader namespace shape and registers the provider', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('web-search-claude-code')
    expect(plugin.inject).toEqual(['web', 'subprocess'])
    const registerSearchProvider = vi.fn()
    const ctx = { web: { registerSearchProvider } } as unknown as Context
    plugin.apply(ctx)
    plugin.apply(ctx, { cwd: '/workspace', graceMs: 1, maxTurns: 1 })
    expect(registerSearchProvider).toHaveBeenCalledTimes(2)
    expect(registerSearchProvider.mock.calls[0]?.[0]).toBeInstanceOf(ClaudeCodeSearchProvider)
  })

  it.each([
    [{ cwd: '' }, 'cwd'],
    [{ graceMs: 0 }, 'graceMs'],
    [{ graceMs: 1.5 }, 'graceMs'],
    [{ maxTurns: 0 }, 'maxTurns'],
    [{ maxTurns: 1.5 }, 'maxTurns'],
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

  it('registers its package-owned invariant companion', async () => {
    const dispose = vi.fn()
    const register = vi.fn((_name: string, _installer: InvariantInstaller) => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-web-search-claude-code',
      expect.any(Function),
    )
    const install = register.mock.calls[0]?.[1]
    if (install === undefined) throw new Error('expected invariant installer')
    await install(new Context(), (message) => { throw new Error(message) })
    expect(invariant.name).toBe('web-search-claude-code-invariant')
    expect(invariant.inject).toEqual(['invariants'])
  })
})
