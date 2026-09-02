import { PassThrough } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { describe, expect, it, vi } from 'vitest'
import { CodexSearchWire } from '../src/wire.ts'

type JsonObject = Record<string, unknown>

interface Harness {
  readonly wire: CodexSearchWire
  readonly peer: JsonRpcLineTransport
  readonly methods: string[]
}

function harness(handle: (method: string, params: JsonObject) => unknown): Harness {
  const input = new PassThrough()
  const output = new PassThrough()
  const wire = new CodexSearchWire(input, output)
  const peer = new JsonRpcLineTransport(output, input)
  const methods: string[] = []
  peer.onRequest(async (method, params) => {
    methods.push(method)
    return await handle(method, params)
  })
  wire.start()
  peer.start()
  return { wire, peer, methods }
}

async function initializedHarness(
  turnResponse: unknown = { turn: { id: 'turn-1' } },
): Promise<Harness> {
  const value = harness((method) => {
    if (method === 'initialize') return {}
    if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
    if (method === 'turn/start') return turnResponse
    if (method === 'turn/interrupt') throw new Error('remote already stopped')
    return {}
  })
  const signal = new AbortController().signal
  await value.wire.initialize(signal)
  await value.wire.startThread('/workspace', { queries: ['q'] }, signal)
  return value
}

describe('CodexSearchWire', () => {
  it('answers current time, rejects interactive requests, interrupts, and handles active notifications', async () => {
    const value = await initializedHarness()
    vi.spyOn(Date, 'now').mockReturnValue(1_234_999)
    await expect(value.peer.request('currentTime/read', { threadId: 'thread-1' })).resolves.toEqual({
      currentTimeAt: 1_234,
    })
    await expect(value.peer.request('account/chatgptAuthTokens/refresh', {})).rejects.toThrow(
      'rejects interactive request',
    )

    const pending = value.wire.runTurn({ queries: ['q'] }, new AbortController().signal)
    await vi.waitFor(() => { expect(value.methods).toContain('turn/start') })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    value.wire.interrupt()
    value.peer.notify('unknown/notification', {})
    value.peer.notify('item/completed', {
      threadId: 'other', turnId: 'turn-1', item: { type: 'webSearch', query: 'q', results: [] },
    })
    value.peer.notify('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'ignore' },
    })
    value.peer.notify('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', query: 'q', results: [] },
    })
    value.peer.notify('turn/completed', {
      threadId: 'other', turn: { id: 'turn-1', status: 'completed' },
    })
    value.peer.notify('turn/completed', {
      threadId: 'thread-1', turn: { id: 'other-turn', status: 'completed' },
    })
    value.peer.notify('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
    })
    await expect(pending).resolves.toEqual({
      items: [{ type: 'webSearch', query: 'q', results: [] }],
    })
    await vi.waitFor(() => { expect(value.methods).toContain('turn/interrupt') })
    value.wire.close()
    value.wire.close()
    value.wire.interrupt()
  })

  it.each([null, 1, []])('rejects malformed initialize response %#', async (response) => {
    const value = harness(method => method === 'initialize' ? response : {})
    await expect(value.wire.initialize(new AbortController().signal)).rejects.toThrow(
      'invalid initialize response',
    )
    value.wire.close()
  })

  it.each([
    [{ thread: null }, 'invalid thread/start thread'],
    [{ thread: { id: 1, ephemeral: true } }, 'invalid thread/start thread id'],
    [{ thread: { id: '', ephemeral: true } }, 'invalid thread/start thread id'],
    [{ thread: { id: 'thread-1', ephemeral: false } }, 'did not create an ephemeral thread'],
  ] as const)('rejects malformed thread response %#', async (response, message) => {
    const value = harness(method => method === 'initialize' ? {} : response)
    const signal = new AbortController().signal
    await value.wire.initialize(signal)
    await expect(value.wire.startThread('/workspace', {
      queries: ['q'], mode: 'indexed', allowedDomains: [],
      location: { country: 'US', region: 'WA', city: 'Seattle', timezone: 'UTC' },
    }, signal)).rejects.toThrow(message)
    value.wire.close()
  })

  it('accepts empty optional controls and a completed turn without search items', async () => {
    const value = harness((method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
      return {}
    })
    const signal = new AbortController().signal
    await value.wire.initialize(signal)
    await value.wire.startThread('/workspace', { queries: ['q'], location: {} }, signal)
    const pending = value.wire.runTurn({ queries: ['q'] }, signal)
    await vi.waitFor(() => { expect(value.methods).toContain('turn/start') })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    value.peer.notify('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
    })
    await expect(pending).resolves.toEqual({ items: [] })
    value.wire.close()
  })

  it('rejects a turn before thread creation and a non-completed terminal turn', async () => {
    const bare = harness(() => ({}))
    await expect(bare.wire.runTurn({ queries: ['q'] }, new AbortController().signal)).rejects.toThrow(
      'before thread creation',
    )
    bare.wire.close()

    const value = await initializedHarness()
    const pending = value.wire.runTurn({ queries: ['q'], blockedDomains: ['blocked.test'] }, new AbortController().signal)
    await vi.waitFor(() => { expect(value.methods).toContain('turn/start') })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    value.peer.notify('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' },
    })
    await expect(pending).rejects.toThrow('ended with status failed')
    value.wire.close()
  })

  it('maps malformed notifications to a fatal protocol rejection', async () => {
    const waiting = Promise.withResolvers<unknown>()
    const value = harness(method => method === 'initialize' ? waiting.promise : {})
    const pending = value.wire.initialize(new AbortController().signal)
    value.peer.notify('item/completed', { threadId: 1 })
    await expect(pending).rejects.toThrow('invalid item/completed thread id')
    value.wire.close()
  })

  it('rejects a directly pre-aborted wire operation with a safe Error reason', async () => {
    const value = harness(() => ({}))
    const controller = new AbortController()
    controller.abort('string reason')
    await expect(value.wire.initialize(controller.signal)).rejects.toThrow('Codex web search was cancelled')
    value.wire.close()
  })
})
