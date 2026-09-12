/**
 * Tests for the mcp-client connection supervisor: crash-driven reconnection
 * with bounded backoff, generation-safe tool re-registration, the failure
 * cap, the stability-window budget reset, and disposal stopping reconnection.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool(request.params, undefined, options)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import type { ConnectionInvalidation, ConnectionSource } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'

// ---- Helpers ----

const testToolSignal = new AbortController().signal

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function sleep(ms: number): Promise<void> {
  // Annotated binding (not withResolvers<void>()): the tests lint layer runs
  // no-invalid-void-type with default options, which rejects the explicit
  // type argument in call position but accepts the inferred form.
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

/** Capture the supervisor's logger lines by level on one context. */
function captureLogs(ctx: Context): { warns: string[]; errors: string[]; infos: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  ctx.logger.info = ((message: unknown) => { infos.push(String(message)) }) as typeof ctx.logger.info
  return { warns, errors, infos }
}

function stdioConfig(reconnect?: Config['reconnect']): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...reconnect === undefined ? {} : { reconnect },
  }
}

/** The tool list the mock server advertises after a successful (re)connect. */
function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    nextCursor: undefined,
  }
}

let callSeq = 0
function nextCallId(): ToolCallId {
  return ToolCallId(`reconnect-${++callSeq}`)
}

// ---- Tests ----

describe('reconnect supervisor', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('reconnects after a transport close, re-syncs tools through the new generation, and serves calls', async () => {
    const { warns, infos } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(instances).toHaveLength(1)

    // The recovered server advertises a different list: the swap must neither
    // duplicate nor leak the pre-crash generation.
    mockListTools.mockResolvedValue(listing('revived'))
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__revived')).toBeDefined() })
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(instances).toHaveLength(2)
    expect(mockConnect).toHaveBeenCalledTimes(2)

    // Post-recovery calls execute through the re-registered definition.
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__srv__revived', arguments: {},
    })
    expect(result.isError).toBe(false)

    // User-visible state: reconnecting and recovered are distinct lines.
    expect(warns.some(line => line.includes('reconnecting in 5ms (attempt 1/5)'))).toBe(true)
    expect(infos.some(line => line.includes('reconnected and re-synced tools'))).toBe(true)

    // A late close signal from the replaced generation is ignored.
    instances[0]!.onclose?.()
    await sleep(30)
    expect(instances).toHaveLength(2)
  })

  it('stops at the failure cap, unregisters the tools, and reports final failure', async () => {
    const { warns, errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 2 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    mockConnect.mockRejectedValue(new Error('server gone'))
    // A failing close on the failed attempt's cleanup must not break the loop.
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.reject(new Error('already closed'))
    })
    instances[0]!.onclose?.()

    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('giving up after 2 consecutive failed reconnect attempts'))).toBe(true)
    })
    // Stale tools do not leak past final failure.
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    // Initial connect + exactly maxAttempts reconnect attempts.
    expect(mockConnect).toHaveBeenCalledTimes(3)
    expect(warns.some(line => line.includes('connection attempt failed: Error: server gone'))).toBe(true)
    expect(warns.some(line => line.includes('connection failed; retrying in 4ms (attempt 2/2)'))).toBe(true)
    await sleep(30)
    expect(mockConnect).toHaveBeenCalledTimes(3)
  })

  it('gives up behind an in-flight re-sync and removes the generation it publishes', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 1 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    const gate: PromiseWithResolvers<unknown> = Promise.withResolvers()
    mockListTools.mockImplementation(() => gate.promise)
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    const resync = handler()
    await vi.waitFor(() => { expect(mockListTools).toHaveBeenCalledTimes(2) })

    mockConnect.mockRejectedValue(new Error('server gone'))
    instances[0]!.onclose?.()
    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('giving up after 1 consecutive failed reconnect attempts'))).toBe(true)
    })

    gate.resolve(listing('late'))
    await resync
    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
      expect(ctx.tools.get('mcp__srv__late')).toBeUndefined()
    })
    expect(mockConnect).toHaveBeenCalledTimes(2)
  })

  it('does not start a replacement until a failed generation reports that it closed', async () => {
    const { warns } = captureLogs(ctx)
    mockConnect.mockRejectedValueOnce(new Error('initialize failed'))
    // Model the SDK's fire-and-forget close after initialize fails: the
    // harness's second close call returns, but the child has not exited yet.
    mockClose.mockResolvedValue(undefined)

    const applying = apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 2 }))
    await vi.waitFor(() => { expect(mockClose).toHaveBeenCalled() })
    await sleep(30)
    expect(instances).toHaveLength(1)

    instances[0]!.onclose?.()
    await applying
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    expect(warns.some(line => line.includes('connection failed; retrying in 2ms (attempt 1/2)'))).toBe(true)
  })

  it('stops reconnecting when a failed generation never reports that it closed', async () => {
    vi.useFakeTimers()
    try {
      const { errors } = captureLogs(ctx)
      mockConnect.mockRejectedValue(new Error('initialize failed'))
      mockClose.mockResolvedValue(undefined)

      const applying = apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 2 }))
      await vi.advanceTimersByTimeAsync(5_000)
      await applying

      expect(instances).toHaveLength(1)
      expect(errors.some(line => line.includes('reconnect stopped to avoid overlapping server processes'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses retry reporting when disposal owns a pending connect rejection', async () => {
    const { warns } = captureLogs(ctx)
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => gate.promise)
    const handle = startConnection(ctx, stdioConfig(), resolveReconnectPolicy(undefined, 'reconnect'))
    await vi.waitFor(() => { expect(instances).toHaveLength(1) })

    const disposing = handle.dispose()
    gate.reject(new Error('disposed connect'))
    await disposing
    await handle.ready

    expect(warns.some(line => line.includes('connection attempt failed'))).toBe(false)
    expect(instances).toHaveLength(1)
  })

  it('bounds disposal while a resolving generation never reports that it closed', async () => {
    vi.useFakeTimers()
    try {
      const { errors } = captureLogs(ctx)
      const gate: PromiseWithResolvers<void> = Promise.withResolvers()
      mockConnect.mockImplementation(() => gate.promise)
      mockClose.mockResolvedValue(undefined)
      const handle = startConnection(ctx, stdioConfig(), resolveReconnectPolicy(undefined, 'reconnect'))
      await vi.advanceTimersByTimeAsync(0)

      const disposing = handle.dispose()
      await vi.advanceTimersByTimeAsync(5_000)
      gate.resolve()
      await disposing

      expect(mockListTools).not.toHaveBeenCalled()
      expect(errors.some(line => line.includes('server shutdown may be incomplete'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose during the backoff wait cancels the pending reconnect', async () => {
    await apply(ctx, stdioConfig({ initialDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    // Now waiting out a 60s backoff; disposal must return promptly anyway.
    await ctx.fiber.dispose()
    await sleep(30)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(1)
  })

  it('a transport close after dispose schedules nothing', async () => {
    const fiber = ctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, stdioConfig())
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    await fiber.dispose()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    // The disposer's client.close() fires onclose in the real SDK.
    instances[0]!.onclose?.()
    await sleep(30)
    expect(instances).toHaveLength(1)
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('reconnect disabled keeps the registered tools and reports manual recovery', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ enabled: false }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    await sleep(30)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    // Pre-reconnect contract: the generation stays registered until disposal.
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    expect(errors.some(line => line.includes('connection lost and reconnect is disabled'))).toBe(true)
  })
  it('reconnect disabled after a failed initial connect reports no registered tools', async () => {
    const { errors } = captureLogs(ctx)
    mockConnect.mockRejectedValue(new Error('refused'))
    await apply(ctx, stdioConfig({ enabled: false }))
    await sleep(30)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(errors.some(line => line.includes('connection failed and reconnect is disabled'))).toBe(true)
    expect(errors.some(line => line.includes('no tools were registered'))).toBe(true)
  })

  it('an uptime past the stability window resets the attempt budget', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 30, maxAttempts: 1 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    // Outlive the stability window (= maxDelayMs), then crash again: the
    // budget restarts at attempt 1 instead of exceeding maxAttempts.
    await sleep(40)
    instances[1]!.onclose?.()
    await vi.waitFor(() => { expect(instances).toHaveLength(3) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(errors).toHaveLength(0)
  })

  it('a crash loop with briefly successful connects still exhausts the cap', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 10_000, maxAttempts: 1 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    // Crash, recover (attempt 1 of 1), crash again well inside the stability
    // window: the successful connect must not launder the budget.
    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    instances[1]!.onclose?.()

    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('giving up after 1 consecutive failed reconnect attempts'))).toBe(true)
    })
    expect(instances).toHaveLength(2)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
  })

  it('a connect rejection racing its own transport close schedules exactly one retry per attempt', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 3 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    // Each reconnect attempt sees the stdio transport die (onclose) AND its
    // connect() reject — the real SDK emits both for a spawn failure.
    mockConnect.mockImplementation(async () => {
      instances.at(-1)!.onclose?.()
      throw new Error('spawn failed')
    })
    instances[0]!.onclose?.()

    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('giving up after 3 consecutive failed reconnect attempts'))).toBe(true)
    })
    // Initial generation + exactly one generation per budgeted attempt: a
    // double-scheduled retry would create more.
    expect(instances).toHaveLength(4)
    expect(errors.filter(line => line.includes('giving up')).length).toBe(1)
  })

  it('a transport that closes during a resolving connect registers nothing from the dead generation', async () => {
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 2 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(mockListTools).toHaveBeenCalledTimes(1)

    mockConnect.mockImplementation(async () => {
      instances.at(-1)!.onclose?.()
    })
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined() })
    // The dead generations never reached tool discovery.
    expect(mockListTools).toHaveBeenCalledTimes(1)
  })

  it('dispose during an in-flight initial sync quiesces without leaking tools', async () => {
    const fiber = ctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    // Block the reconnect attempt's tool discovery until after dispose starts.
    const gate: PromiseWithResolvers<unknown> = Promise.withResolvers()
    mockListTools.mockImplementation(() => gate.promise)
    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(mockListTools).toHaveBeenCalledTimes(2) })

    const disposing = fiber.dispose()
    await sleep(10)
    gate.resolve(listing('late'))
    await disposing

    // The late sync's swap ran, then disposal unregistered its result: no
    // generation survives the plugin.
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__late')).toBeUndefined()
  })

  it('a re-sync failing because dispose closed the transport stays silent', async () => {
    const { errors } = captureLogs(ctx)
    const fiber = ctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, stdioConfig())
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    const gate: PromiseWithResolvers<unknown> = Promise.withResolvers()
    mockListTools.mockImplementation(() => gate.promise)
    const handler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    const resync = handler()
    await vi.waitFor(() => { expect(mockListTools).toHaveBeenCalledTimes(2) })

    const disposing = fiber.dispose()
    await sleep(10)
    gate.reject(new Error('Connection closed'))
    await disposing
    await resync

    expect(errors.some(line => line.includes('tool re-sync failed'))).toBe(false)
  })

  it('a stale notification handler from a replaced generation is ignored', async () => {
    await apply(ctx, stdioConfig({ initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 5 }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    const listCalls = mockListTools.mock.calls.length

    const staleHandler = mockSetNotificationHandler.mock.calls[0]![1] as () => Promise<void>
    await staleHandler()
    expect(mockListTools).toHaveBeenCalledTimes(listCalls)
  })
})

// ---- Host connection source ----

/** A scripted ConnectionSource: transport availability plus a fireable invalidation broadcast. */
function fakeSource(): {
  source: ConnectionSource & { connect: ReturnType<typeof vi.fn> }
  fire: (reason: ConnectionInvalidation) => void
  listenerCount: () => number
} {
  const listeners = new Set<(reason: ConnectionInvalidation) => void>()
  const connect = vi.fn(async (_signal: AbortSignal) => ({} as Transport))
  const source = {
    connect,
    onInvalidate: (listener: (reason: ConnectionInvalidation) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    source,
    fire: (reason) => { for (const listener of [...listeners]) listener(reason) },
    listenerCount: () => listeners.size,
  }
}

function hostConfig(reconnect?: Config['reconnect']): Config {
  return {
    transport: 'host-connection',
    serverName: 'srv',
    connectionId: 'test-conn',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...reconnect === undefined ? {} : { reconnect },
  }
}

describe('connection source (host-connection)', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  /** Start the supervisor over the scripted source, bypassing apply's owner resolution. */
  function start(source: ConnectionSource, reconnect?: Config['reconnect']) {
    return startConnection(ctx, hostConfig(reconnect), resolveReconnectPolicy(reconnect, 'reconnect'), source)
  }

  it('rejects host-managed configuration without its connection authority', async () => {
    try {
      expect(() => startConnection(ctx, hostConfig(), resolveReconnectPolicy(undefined, 'reconnect')))
        .toThrow('requires a connection source')
      expect(mockConnect).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('retries transport resolution failures without exposing remote error payloads', async () => {
    vi.useFakeTimers()
    const { source } = fakeSource()
    const { warns } = captureLogs(ctx)
    source.connect.mockRejectedValueOnce('secret server payload')
      .mockRejectedValueOnce(Object.assign(new Error('another secret'), { code: 'AUTH_REFRESH' }))
      .mockResolvedValue({})
    const handle = start(source, { initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 })
    try {
      const outcome = await handle.ready
      expect(outcome.error).toEqual(new Error('mcp-client(srv): host connection transport resolution failed (unknown-error)'))
      await vi.advanceTimersByTimeAsync(5)
      expect(source.connect).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10)
      expect(source.connect).toHaveBeenCalledTimes(3)
      expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
      expect(warns.join('\n')).toContain('(AUTH_REFRESH)')
      expect(warns.join('\n')).not.toContain('secret')
      expect((await handle.ready).error).toBe(outcome.error)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('an authority change cancels an armed outage retry before reconnecting immediately', async () => {
    vi.useFakeTimers()
    const { source, fire } = fakeSource()
    const handle = start(source, { initialDelayMs: 100, maxDelayMs: 100, maxAttempts: 3 })
    try {
      await handle.ready
      instances[0]!.onclose?.()
      expect(source.connect).toHaveBeenCalledOnce()
      fire('reauthorized')
      await vi.advanceTimersByTimeAsync(0)
      expect(source.connect).toHaveBeenCalledTimes(2)
      expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
      await vi.advanceTimersByTimeAsync(100)
      expect(source.connect).toHaveBeenCalledTimes(2)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it.each(['resolve', 'reject'] as const)('ignores a late transport %s after disposal and a previously queued authority callback', async (outcome) => {
    const gate = Promise.withResolvers<Transport | undefined>()
    const { source } = fakeSource()
    const subscribe = vi.spyOn(source, 'onInvalidate')
    source.connect.mockReturnValue(gate.promise)
    const { warns } = captureLogs(ctx)
    const handle = start(source)
    const callback = subscribe.mock.calls[0]![0]
    const disposing = handle.dispose()
    try {
      callback('reauthorized')
      expect((source.connect.mock.calls[0]![0] as AbortSignal).aborted).toBe(true)
      if (outcome === 'resolve') gate.resolve({} as Transport)
      else gate.reject(new Error('cancelled source operation'))
      await disposing
      await handle.ready
      expect(source.connect).toHaveBeenCalledOnce()
      expect(mockConnect).not.toHaveBeenCalled()
      expect(warns).toEqual([])
      expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    } finally {
      gate.resolve(undefined)
      await disposing
      await ctx.fiber.dispose()
    }
  })

  it.each(['resolve', 'reject'] as const)('fences a superseded source %s while the replacement authority holds', async (outcome) => {
    const gate = Promise.withResolvers<Transport | undefined>()
    const { source, fire } = fakeSource()
    source.connect.mockReturnValueOnce(gate.promise).mockResolvedValue(undefined)
    const { warns } = captureLogs(ctx)
    const handle = start(source)
    try {
      fire('revoked')
      expect((source.connect.mock.calls[0]![0] as AbortSignal).aborted).toBe(true)
      if (outcome === 'resolve') gate.resolve({} as Transport)
      else gate.reject(new Error('superseded source operation'))
      await handle.ready
      await vi.waitFor(() => { expect(source.connect).toHaveBeenCalledTimes(2) })
      expect(mockConnect).not.toHaveBeenCalled()
      expect(warns).toEqual([])
      expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    } finally {
      gate.resolve(undefined)
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('holds without connecting while the authority yields no transport', async () => {
    const { infos } = captureLogs(ctx)
    const { source } = fakeSource()
    source.connect.mockResolvedValue(undefined)

    const handle = start(source)
    const outcome = await handle.ready
    await sleep(30)

    expect(mockConnect).not.toHaveBeenCalled()
    expect(outcome.error).toBeDefined()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(infos.some(line => line.includes('host connection is holding'))).toBe(true)
    await handle.dispose()
  })

  it('an invalidation closes the live generation and re-establishes immediately without outage budget', async () => {
    const { warns, infos } = captureLogs(ctx)
    const { source, fire } = fakeSource()
    const handle = start(source, { initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(instances).toHaveLength(1)

    mockListTools.mockResolvedValue(listing('revived'))
    fire('config-changed')

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__revived')).toBeDefined() })
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(instances).toHaveLength(2)
    // The bounce reconnected at once: no backoff wait, no attempt-budget line.
    expect(warns.some(line => line.includes('retrying in'))).toBe(false)
    expect(infos.some(line => line.includes('host connection invalidated (config-changed)'))).toBe(true)

    // The outage budget is untouched: the next transport crash starts at attempt 1.
    instances[1]!.onclose?.()
    await vi.waitFor(() => {
      expect(warns.some(line => line.includes('reconnecting in 5ms (attempt 1/5)'))).toBe(true)
    })
    await handle.dispose()
  })

  it('continues queued invalidations after the SDK rejects notification setup for a replacement', async () => {
    const { source, fire } = fakeSource()
    const handle = start(source)
    try {
      await handle.ready
      expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
      mockSetNotificationHandler.mockImplementationOnce(() => {
        throw new Error('fixture SDK notification setup failed')
      })
      mockListTools.mockResolvedValue(listing('revived'))

      fire('config-changed')
      fire('reauthorized')

      await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__revived')).toBeDefined() })
      expect(instances).toHaveLength(3)
      expect(mockConnect).toHaveBeenCalledTimes(2)
      expect(mockClose).toHaveBeenCalledTimes(2)
      expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('withdraws tools promptly and holds when revocation finds the authority down', async () => {
    const { source, fire } = fakeSource()
    const handle = start(source)
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    source.connect.mockResolvedValue(undefined)
    fire('revoked')

    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined() })
    await sleep(30)
    // The revoked connection neither reconnects nor resurrects on its own.
    expect(instances).toHaveLength(1)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    await handle.dispose()
  })

  it('does not retry a failed generation whose close overlaps authority withdrawal', async () => {
    const closing: PromiseWithResolvers<void> = Promise.withResolvers()
    const { source, fire } = fakeSource()
    const { warns } = captureLogs(ctx)
    mockConnect.mockRejectedValueOnce(new Error('fixture connect failed'))
    mockClose.mockImplementationOnce(() => closing.promise)
    const handle = start(source)
    try {
      await vi.waitFor(() => { expect(mockClose).toHaveBeenCalledOnce() })
      source.connect.mockResolvedValue(undefined)
      fire('revoked')
      closing.resolve()

      expect((await handle.ready).error).toBeDefined()
      await vi.waitFor(() => { expect(source.connect).toHaveBeenCalledTimes(2) })
      expect(instances).toHaveLength(1)
      expect(warns.some(line => line.includes('retrying in'))).toBe(false)
      expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    } finally {
      closing.resolve()
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('revocation during an in-flight connect fences the attempt with no resurrection', async () => {
    const { source, fire } = fakeSource()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => gate.promise)
    const handle = start(source)
    await vi.waitFor(() => { expect(instances).toHaveLength(1) })

    // Revocation takes the authority down before the fenced attempt settles.
    source.connect.mockResolvedValue(undefined)
    fire('revoked')
    gate.reject(new Error('connect interrupted'))
    await handle.ready
    await sleep(30)

    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(instances).toHaveLength(1)

    // The bounce holds while the authority is down; reauthorization connects anew.
    // Restore connect success first: the gate rejection owned only the fenced attempt.
    mockConnect.mockResolvedValue(undefined)
    source.connect.mockResolvedValue({})
    fire('reauthorized')
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    await handle.dispose()
  })

  it('stops re-establishment when the fenced generation never reports that it closed', async () => {
    vi.useFakeTimers()
    try {
      const { errors } = captureLogs(ctx)
      const { source, fire } = fakeSource()
      const handle = start(source)
      await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

      // The generation ignores close(): the bounce barrier must fail closed.
      mockClose.mockResolvedValue(undefined)
      fire('revoked')
      // A second bounce is already queued when the first close barrier expires.
      fire('reauthorized')
      await vi.advanceTimersByTimeAsync(5_000)

      expect(errors.some(line => line.includes('during a host bounce'))).toBe(true)
      expect(instances).toHaveLength(1)
      // Further authority changes must not erase the unresolved close barrier.
      fire('config-changed')
      fire('reauthorized')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(instances).toHaveLength(1)
      await handle.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still withdraws cached tools after an outage close timeout permanently stops reconnecting', async () => {
    vi.useFakeTimers()
    const { errors } = captureLogs(ctx)
    const { source, fire } = fakeSource()
    const handle = start(source, { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 })
    try {
      await handle.ready
      expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
      mockConnect.mockRejectedValue(new Error('fixture connect failed'))
      mockClose.mockResolvedValue(undefined)
      instances[0]!.onclose?.()
      await vi.advanceTimersByTimeAsync(6_000)
      expect(errors.some(line => line.includes('failed generation did not close'))).toBe(true)
      expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
      fire('revoked')
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
      fire('reauthorized')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(instances).toHaveLength(2)
    } finally {
      await handle.dispose()
      vi.useRealTimers()
    }
  })

  it('reauthorization revives the give-up terminal state that outage budget exhaustion reached', async () => {
    const { errors } = captureLogs(ctx)
    const { source, fire } = fakeSource()
    const handle = start(source, { initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 1 })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    mockConnect.mockRejectedValue(new Error('server gone'))
    instances[0]!.onclose?.()
    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('giving up after 1 consecutive failed reconnect attempts'))).toBe(true)
    })
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    const attempts = mockConnect.mock.calls.length

    mockConnect.mockResolvedValue(undefined)
    fire('reauthorized')
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(mockConnect.mock.calls.length).toBeGreaterThan(attempts)
    await handle.dispose()
  })

  it('a scheduled retry that finds the authority down holds instead of spending attempts', async () => {
    const { infos } = captureLogs(ctx)
    const { source, fire } = fakeSource()
    const handle = start(source, { initialDelayMs: 2, maxDelayMs: 8, maxAttempts: 3 })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    source.connect.mockResolvedValue(undefined)
    instances[0]!.onclose?.()
    await vi.waitFor(() => {
      expect(infos.some(line => line.includes('host connection is holding'))).toBe(true)
    })
    await sleep(30)
    expect(instances).toHaveLength(1)

    // Only an authority signal re-establishes; the hold itself never retries.
    // (The crashed generation's tools stay registered through the outage, so
    // the new generation itself is the signal to await.)
    source.connect.mockResolvedValue({})
    fire('reauthorized')
    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    await handle.dispose()
  })

  it('dispose unsubscribes the source before teardown so late invalidations are inert', async () => {
    const { source, fire, listenerCount } = fakeSource()
    const handle = start(source)
    await vi.waitFor(() => { expect(instances).toHaveLength(1) })
    expect(listenerCount()).toBe(1)

    await handle.dispose()
    expect(listenerCount()).toBe(0)

    fire('reauthorized')
    await sleep(30)
    expect(instances).toHaveLength(1)
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })
})

// ---- Policy resolution ----

describe('resolveReconnectPolicy', () => {
  const path = 'mcp-client(srv): reconnect'

  it('resolves omission to the defaults, frozen', () => {
    const policy = resolveReconnectPolicy(undefined, path)
    expect(policy).toEqual(RECONNECT_DEFAULTS)
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it('keeps explicit values', () => {
    expect(resolveReconnectPolicy(
      { enabled: false, initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 7 },
      path,
    )).toEqual({ enabled: false, initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 7 })
  })

  it('rejects unknown keys', () => {
    expect(() => resolveReconnectPolicy({ jitterRatio: 0.5 } as never, path))
      .toThrow(/reconnect\.jitterRatio is not a reconnect option/)
  })

  it('rejects out-of-range delays', () => {
    expect(() => resolveReconnectPolicy({ initialDelayMs: 0 }, path)).toThrow(/initialDelayMs must be a positive finite number/)
    expect(() => resolveReconnectPolicy({ initialDelayMs: Number.POSITIVE_INFINITY }, path)).toThrow(/initialDelayMs/)
    expect(() => resolveReconnectPolicy({ maxDelayMs: -1 }, path)).toThrow(/maxDelayMs must be a positive finite number/)
  })

  it('rejects an initial delay above the ceiling', () => {
    expect(() => resolveReconnectPolicy({ initialDelayMs: 100, maxDelayMs: 5 }, path))
      .toThrow(/initialDelayMs must be less than or equal to maxDelayMs/)
  })

  it('rejects non-positive-integer attempt caps', () => {
    expect(() => resolveReconnectPolicy({ maxAttempts: 0 }, path)).toThrow(/maxAttempts must be a positive integer/)
    expect(() => resolveReconnectPolicy({ maxAttempts: 1.5 }, path)).toThrow(/maxAttempts must be a positive integer/)
  })

  it('apply fails loud at load on a misconfigured reconnect', async () => {
    const ctx = await mountRegistry()
    await expect(apply(ctx, stdioConfig({ initialDelayMs: 100, maxDelayMs: 5 })))
      .rejects.toThrow(/initialDelayMs must be less than or equal to maxDelayMs/)
  })
})
