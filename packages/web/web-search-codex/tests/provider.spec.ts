import { PassThrough } from 'node:stream'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { WebError } from '@deepseek-ai/dsh-web'
import { describe, expect, it, type Mock, vi } from 'vitest'
import {
  CODEX_AUTH_MESSAGE,
  CODEX_MISSING_MESSAGE,
  CodexSearchProvider,
  type CodexSearchProviderOptions,
  normalizeCodexResult,
} from '../src/provider.ts'

type JsonObject = Record<string, unknown>
type Handler = (method: string, params: JsonObject, peer: JsonRpcLineTransport) => unknown
type ResolveExecutable = SubprocessRuntime['resolveExecutable']

interface Deferred<T> {
  promise: Promise<T>
  reject: (error: unknown) => void
  resolve: (value: T) => void
}

interface FakeProcess {
  child: SubprocessHandle
  done: Deferred<SubprocessOutcome>
  requests: { method: string; params: JsonObject }[]
  terminate: ReturnType<typeof vi.fn>
  waitForExit: ReturnType<typeof vi.fn>
}

interface FakeRuntime {
  process: FakeProcess
  resolveExecutable: Mock<ResolveExecutable>
  runtime: SubprocessRuntime
  spawn: ReturnType<typeof vi.fn>
  specs: SubprocessSpawnSpec[]
}

function deferred<T>(): Deferred<T> {
  const value = Promise.withResolvers<T>()
  return { promise: value.promise, reject: value.reject, resolve: value.resolve }
}

function fakeProcess(handler: Handler, diagnostic = ''): FakeProcess {
  const input = new PassThrough()
  const output = new PassThrough()
  const peer = new JsonRpcLineTransport(output, input)
  const requests: { method: string; params: JsonObject }[] = []
  peer.onRequest(async (method, params) => {
    requests.push({ method, params })
    return await handler(method, params, peer)
  })
  peer.start()
  const done = deferred<SubprocessOutcome>()
  let settled = false
  const terminate = vi.fn(() => {
    if (!settled) {
      settled = true
      done.resolve({ exitCode: null, signal: 'SIGTERM' })
    }
  })
  const waitForExit = vi.fn(async () => true)
  const child: SubprocessHandle = {
    pid: 123,
    stdin: output,
    stdout: input,
    stderr: undefined,
    collected: diagnostic.length === 0
      ? {}
      : { stderr: { readFrom: () => ({ text: diagnostic, nextOffset: diagnostic.length, lossy: false }) } },
    done: done.promise,
    terminate,
    waitForExit,
  }
  return { child, done, requests, terminate, waitForExit }
}

function successfulProcess(overrides: Partial<JsonObject> = {}): FakeProcess {
  return fakeProcess((method, _params, peer) => {
    if (method === 'initialize') return {}
    if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
    if (method === 'turn/start') {
      peer.notify('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'webSearch',
          query: 'query',
          results: [{ url: 'https://a.test', title: 'A', page_age: 'yesterday' }],
          ...overrides,
        },
      })
      peer.notify('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', final_answer: 'answer' },
      })
      peer.notify('turn/completed', {
        threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
      })
      return { turn: { id: 'turn-1' } }
    }
    if (method === 'turn/interrupt') return {}
    return {}
  })
}

function fakeRuntime(process: FakeProcess = successfulProcess()): FakeRuntime {
  const specs: SubprocessSpawnSpec[] = []
  const resolveExecutable = vi.fn<ResolveExecutable>(async (
    command: string,
    _env?: Readonly<Record<string, string>>,
    _signal?: AbortSignal,
  ) => `/resolved/${command.split('/').at(-1)}`)
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
    specs.push(spec)
    return process.child
  })
  return {
    process,
    resolveExecutable,
    spawn,
    specs,
    runtime: { resolveExecutable, spawn } as unknown as SubprocessRuntime,
  }
}

function options(overrides: Partial<CodexSearchProviderOptions> = {}): CodexSearchProviderOptions {
  return {
    cwd: process.cwd(),
    requestTimeoutMs: 1_000,
    disposeGraceMs: 25,
    maxResults: 8,
    maxPayloadBytes: 262_144,
    executable: 'codex-test',
    ...overrides,
  }
}

function provider(runtime: FakeRuntime, overrides: Partial<CodexSearchProviderOptions> = {}): CodexSearchProvider {
  return new CodexSearchProvider(runtime.runtime, options(overrides))
}

async function expectCode(pending: Promise<unknown>, code: string, message?: string): Promise<void> {
  try {
    await pending
    throw new Error('expected rejection')
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WebError)
    if (!(error instanceof WebError)) throw error
    expect(error.code).toBe(code)
    if (message !== undefined) expect(error.message).toBe(message)
  }
}

describe('CodexSearchProvider', () => {
  it('executes the exact override argv and normalizes structured output', async () => {
    const runtime = fakeRuntime()
    const result = await provider(runtime).search({ query: 'query', maxResults: 3 })
    expect(result).toEqual({
      sources: [{ url: 'https://a.test', title: 'A', publishedAt: 'yesterday' }],
      content: 'answer',
      truncated: false,
    })
    expect(runtime.resolveExecutable).toHaveBeenCalledWith('codex-test', undefined, expect.any(AbortSignal))
    expect(runtime.specs[0]).toMatchObject({
      argv: ['/resolved/codex-test', 'app-server', '--stdio'],
      cwd: process.cwd(),
      graceMs: 25,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 262_144 } },
    })
    expect(runtime.process.terminate).toHaveBeenCalledOnce()
    expect(runtime.process.waitForExit).toHaveBeenCalledOnce()
  })

  it('uses node plus the package-local wrapper by default', async () => {
    const runtime = fakeRuntime()
    const defaults = options()
    delete defaults.executable
    const value = new CodexSearchProvider(runtime.runtime, defaults)
    expect(value.available()).toBe(true)
    await value.search({ query: 'query' })
    expect(runtime.specs[0]?.argv).toEqual([
      process.execPath, '/resolved/codex.js', 'app-server', '--stdio',
    ])
  })

  it('provides synchronous availability hints without resolving or spawning', () => {
    const runtime = fakeRuntime()
    expect(provider(runtime).available()).toBe(true)
    expect(provider(runtime, { executable: '/definitely/not/present/codex' }).available()).toBe(false)
    expect(provider(runtime, { executable: process.execPath }).available()).toBe(true)
    expect(runtime.resolveExecutable).not.toHaveBeenCalled()
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it.each([
    { cwd: '' },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 600_001 },
    { requestTimeoutMs: 1.5 },
    { disposeGraceMs: 0 },
    { disposeGraceMs: 60_001 },
    { maxResults: 0 },
    { maxResults: 51 },
    { maxPayloadBytes: 1_047 },
    { maxPayloadBytes: 1_048_577 },
    { executable: '' },
    { executable: './codex' },
  ])('rejects invalid options %#', async (override) => {
    const runtime = fakeRuntime()
    const value = provider(runtime, override)
    expect(value.available()).toBe(false)
    await expectCode(value.search({ query: 'q' }), 'WEB_INVALID_CONFIG')
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('validates the configured working directory at execution', async () => {
    const runtime = fakeRuntime()
    await expectCode(provider(runtime, { cwd: import.meta.filename }).search({ query: 'q' }), 'WEB_INVALID_CONFIG')
    await expectCode(provider(runtime, { cwd: '/definitely/missing/directory' }).search({ query: 'q' }), 'WEB_INVALID_CONFIG')
  })

  it('maps missing executable resolution to configured-unavailable', async () => {
    const runtime = fakeRuntime()
    runtime.resolveExecutable.mockRejectedValueOnce(new Error('not found TOKEN=private'))
    await expectCode(
      provider(runtime).search({ query: 'q' }),
      'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
      CODEX_MISSING_MESSAGE,
    )
  })

  it('rejects pre-aborted and resolution-time caller aborts', async () => {
    const before = fakeRuntime()
    const pre = new AbortController()
    pre.abort('stop')
    await expectCode(provider(before).search({ query: 'q' }, pre.signal), 'WEB_ABORTED')
    expect(before.resolveExecutable).not.toHaveBeenCalled()

    const during = fakeRuntime()
    during.resolveExecutable.mockImplementationOnce((_command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal) => {
      if (signal === undefined) throw new Error('expected signal')
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      })
    })
    const controller = new AbortController()
    const pending = provider(during).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('caller cancelled'))
    await expectCode(pending, 'WEB_ABORTED')
  })

  it('maps resolution and turn timeouts to the exact provider error', async () => {
    const resolution = fakeRuntime()
    resolution.resolveExecutable.mockImplementationOnce((
      _command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal,
    ) => {
      if (signal === undefined) throw new Error('expected signal')
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('timeout')) }, { once: true })
      })
    })
    await expectCode(
      provider(resolution, { requestTimeoutMs: 5 }).search({ query: 'q' }),
      'WEB_PROVIDER_ERROR',
      'Codex web search timed out after 5 ms',
    )

    const waiting = fakeRuntime(fakeProcess((method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
      return {}
    }))
    await expectCode(
      provider(waiting, { requestTimeoutMs: 5 }).search({ query: 'q' }),
      'WEB_PROVIDER_ERROR',
      'Codex web search timed out after 5 ms',
    )
  })

  it('interrupts a known turn and reaches quiescence before caller abort rejects', async () => {
    const started = deferred<boolean>()
    const process = fakeProcess((method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        started.resolve(true)
        return { turn: { id: 'turn-1' } }
      }
      return {}
    })
    const runtime = fakeRuntime(process)
    const controller = new AbortController()
    const pending = provider(runtime).search({ query: 'q' }, controller.signal)
    await started.promise
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    controller.abort(new Error('stop'))
    await expectCode(pending, 'WEB_ABORTED')
    await vi.waitFor(() => {
      expect(process.requests.some(request => request.method === 'turn/interrupt')).toBe(true)
    })
    expect(process.terminate).toHaveBeenCalled()
    expect(process.waitForExit).toHaveBeenCalled()
  })

  it('disposal aborts in-flight work and leaves no child alive', async () => {
    const started = deferred<boolean>()
    const process = fakeProcess((method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        started.resolve(true)
        return { turn: { id: 'turn-1' } }
      }
      return {}
    })
    const runtime = fakeRuntime(process)
    const value = provider(runtime)
    const pending = value.search({ query: 'q' })
    await started.promise
    process.waitForExit.mockRejectedValueOnce(new Error('already gone'))
    await value.dispose()
    await expectCode(pending, 'WEB_PROVIDER_ERROR')
    await value.dispose()
    expect(process.terminate).toHaveBeenCalled()
  })

  it('maps spawn, pipe, and generic process failures without leaking details', async () => {
    const spawn = fakeRuntime()
    spawn.spawn.mockImplementationOnce(() => { throw new Error('SECRET=private') })
    await expectCode(provider(spawn).search({ query: 'q' }), 'WEB_PROVIDER_ERROR', 'Codex web search failed')

    for (const missing of ['stdin', 'stdout'] as const) {
      const process = successfulProcess()
      const child = { ...process.child, [missing]: undefined }
      const runtime = fakeRuntime({ ...process, child })
      await expectCode(provider(runtime).search({ query: 'q' }), 'WEB_PROVIDER_ERROR', 'Codex web search failed')
    }
  })

  it.each([
    ['Login required; run codex login', 7, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE', CODEX_AUTH_MESSAGE],
    ['ordinary provider prose', 7, 'WEB_PROVIDER_ERROR', 'Codex web search failed'],
    ['not authenticated', 0, 'WEB_PROVIDER_ERROR', 'Codex web search failed'],
  ])('classifies only stable nonzero auth evidence: %s', async (diagnostic, exitCode, code, message) => {
    const process = fakeProcess(() => new Promise(() => {}), diagnostic)
    process.done.resolve({ exitCode, signal: null })
    await expectCode(provider(fakeRuntime(process)).search({ query: 'q' }), code, message)
  })

  it('maps rejected process settlement and protocol failures', async () => {
    const rejected = fakeProcess(() => new Promise(() => {}))
    rejected.done.reject(new Error('private process failure'))
    await expectCode(provider(fakeRuntime(rejected)).search({ query: 'q' }), 'WEB_PROVIDER_ERROR')

    const malformed = fakeRuntime(fakeProcess((method) => {
      if (method === 'initialize') return null
      return {}
    }))
    await expectCode(provider(malformed).search({ query: 'q' }), 'WEB_PROVIDER_PROTOCOL')
  })

  it.each([
    { results: [], query: 'query' },
    { results: [{ url: 'https://a.test' }], query: 3 },
    { results: 'bad', query: 'query' },
    { results: [{ url: 'https://a.test' }], query: 'query', type: 'other' },
  ])('rejects missing or malformed completed web-search items %#', async (override) => {
    await expectCode(
      provider(fakeRuntime(successfulProcess(override))).search({ query: 'q' }),
      'WEB_PROVIDER_PROTOCOL',
    )
  })

  it('rejects duplicate completed web-search items', async () => {
    const process = fakeProcess((method, _params, peer) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        for (const id of ['a', 'b']) {
          peer.notify('item/completed', {
            threadId: 'thread-1', turnId: 'turn-1',
            item: { id, type: 'webSearch', query: 'q', results: [{ url: 'https://a.test' }] },
          })
        }
        peer.notify('turn/completed', {
          threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
        })
        return { turn: { id: 'turn-1' } }
      }
      return {}
    })
    await expectCode(provider(fakeRuntime(process)).search({ query: 'q' }), 'WEB_PROVIDER_PROTOCOL')
  })

  it('accepts a valid web-search item without an agent answer', async () => {
    const process = fakeProcess((method, _params, peer) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        peer.notify('item/completed', {
          threadId: 'thread-1', turnId: 'turn-1',
          item: { type: 'webSearch', query: 'q', results: [{ url: 'https://a.test' }] },
        })
        peer.notify('turn/completed', {
          threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
        })
        return { turn: { id: 'turn-1' } }
      }
      return {}
    })
    await expect(provider(fakeRuntime(process)).search({ query: 'q' })).resolves.toEqual({
      sources: [{ url: 'https://a.test' }], truncated: false,
    })
  })

  it('surfaces cleanup failure only when there is no primary failure', async () => {
    const process = successfulProcess()
    process.waitForExit.mockRejectedValueOnce(new Error('private cleanup failure'))
    await expectCode(
      provider(fakeRuntime(process)).search({ query: 'q' }),
      'WEB_PROVIDER_ERROR',
      'Codex web search cleanup failed',
    )

    const primary = fakeProcess((method) => {
      if (method === 'initialize') throw new Error('primary failure')
      return {}
    })
    primary.waitForExit.mockRejectedValueOnce(new Error('cleanup failure'))
    await expectCode(provider(fakeRuntime(primary)).search({ query: 'q' }), 'WEB_PROVIDER_ERROR', 'Codex web search failed')
  })
})

describe('normalizeCodexResult', () => {
  it('validates, deduplicates, preserves order, maps dates, and caps sources', () => {
    const result = normalizeCodexResult({ sources: [
      { url: 3 },
      { url: 'not a url' },
      { url: 'file:///bad' },
      { url: 'http://a.test', title: 'A', snippet: 'one', publishedAt: '2026-01-01' },
      { url: 'http://a.test' },
      { url: 'https://b.test', title: '', snippet: '', published_at: '2026-02-02' },
      { url: 'https://c.test', page_age: 'today' },
      { url: 'https://d.test' },
    ] }, 3, 262_144)
    expect(result).toEqual({
      sources: [
        { url: 'http://a.test', title: 'A', snippet: 'one', publishedAt: '2026-01-01' },
        { url: 'https://b.test', publishedAt: '2026-02-02' },
        { url: 'https://c.test', publishedAt: 'today' },
      ],
      truncated: true,
    })
  })

  it('truncates content safely and then drops sources to meet payload limits', () => {
    const content = normalizeCodexResult({ sources: [], answer: 'x'.repeat(2_000) }, 8, 1_048)
    expect(content.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(1_048)

    const sources = normalizeCodexResult({ sources: [
      { url: `https://a.test/${'x'.repeat(2_000)}` },
    ] }, 8, 1_048)
    expect(sources).toEqual({ sources: [], truncated: true })

    expect(normalizeCodexResult({ sources: [], answer: 'x' }, 8, 1)).toEqual({
      sources: [], truncated: true,
    })
  })

  it('returns uncapped optional content and empty optional fields correctly', () => {
    expect(normalizeCodexResult({
      answer: 'answer',
      sources: [{
        url: 'https://a.test', title: null, snippet: null, publishedAt: '', published_at: '', page_age: '',
      }],
    }, 8, 262_144)).toEqual({
      sources: [{ url: 'https://a.test' }], content: 'answer', truncated: false,
    })
  })
})
