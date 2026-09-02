import { PassThrough } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexProtocolError, CodexSearchWire } from '../src/wire.ts'

type JsonObject = Record<string, unknown>
type Handler = (method: string, params: JsonObject, peer: JsonRpcLineTransport) => unknown

interface Harness {
  input: PassThrough
  methods: string[]
  notifications: string[]
  params: JsonObject[]
  peer: JsonRpcLineTransport
  wire: CodexSearchWire
}

function harness(handler: Handler): Harness {
  const input = new PassThrough()
  const output = new PassThrough()
  const wire = new CodexSearchWire(input, output)
  const peer = new JsonRpcLineTransport(output, input)
  const methods: string[] = []
  const params: JsonObject[] = []
  const notifications: string[] = []
  peer.onRequest(async (method, request) => {
    methods.push(method)
    params.push(request)
    return await handler(method, request, peer)
  })
  peer.onNotification((method) => { notifications.push(method) })
  wire.start()
  peer.start()
  return { input, methods, notifications, params, peer, wire }
}

function standard(handler?: Handler): Harness {
  return harness((method, params, peer) => {
    if (method === 'initialize') return {}
    if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } }
    if (method === 'turn/interrupt') return {}
    return handler?.(method, params, peer) ?? {}
  })
}

async function initialized(value: Harness): Promise<AbortSignal> {
  const signal = new AbortController().signal
  await value.wire.initialize(signal)
  await value.wire.startThread('/workspace', signal)
  return signal
}

function complete(value: Harness, status = 'completed'): void {
  value.peer.notify('turn/completed', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status },
  })
}

afterEach(() => { vi.restoreAllMocks() })

describe('CodexSearchWire replay protocol', () => {
  it('replays exact handshake, early items, current time, completion, and interrupt', async () => {
    const value = harness((method, _params, peer) => {
      if (method === 'initialize') return { serverInfo: { name: 'codex' } }
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        peer.notify('unrelated/event', { ignored: true })
        peer.notify('item/completed', {
          threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', text: 'ignored' },
        })
        peer.notify('item/completed', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'webSearch', query: 'query', results: [{ url: 'https://example.test' }] },
        })
        peer.notify('item/completed', {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', final_answer: 'answer' },
        })
        complete(value)
        return { turn: { id: 'turn-1' } }
      }
      if (method === 'turn/interrupt') return {}
      throw new Error(`unexpected request: ${method}`)
    })
    vi.spyOn(Date, 'now').mockReturnValue(1_234_999)
    const signal = new AbortController().signal
    await value.wire.initialize(signal)
    expect(await value.peer.request('currentTime/read', {})).toEqual({ currentTimeAt: 1_234 })
    await expect(value.peer.request('approval/request', {})).rejects.toMatchObject({ code: -32603 })
    await value.wire.startThread('/workspace', signal)
    const result = await value.wire.runTurn('query', signal)
    expect(result.items).toEqual([
      { type: 'webSearch', query: 'query', results: [{ url: 'https://example.test' }] },
      { type: 'agentMessage', final_answer: 'answer' },
    ])
    expect(value.methods.slice(0, 3)).toEqual(['initialize', 'thread/start', 'turn/start'])
    expect(value.notifications).toContain('initialized')
    expect(value.params[0]).toEqual({
      clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.0.1' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    })
    expect(value.params[1]).toEqual({
      cwd: '/workspace',
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { web_search: 'live', tools: { web_search: true } },
    })
    expect(value.params[2]).toEqual({
      threadId: 'thread-1',
      input: [{
        type: 'text',
        text: 'Use the built-in web search exactly once. Search exactly as supplied: query '
          + 'Use no other tools; return source URLs and snippets.',
        text_elements: [],
      }],
    })
    value.wire.interrupt()
    await vi.waitFor(() => { expect(value.methods).toContain('turn/interrupt') })
    value.wire.close()
    value.wire.close()
    value.wire.interrupt()
  })

  it('accepts completion delivered after turn/start response', async () => {
    const value = standard()
    const signal = await initialized(value)
    const pending = value.wire.runTurn('q', signal)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    complete(value)
    await expect(pending).resolves.toEqual({ items: [] })
    value.wire.close()
  })

  it('rejects turns before thread creation and pre-aborted RPC phases', async () => {
    const value = standard()
    const controller = new AbortController()
    controller.abort('stop')
    await expect(value.wire.initialize(controller.signal)).rejects.toThrow('cancelled')
    await expect(value.wire.runTurn('q', new AbortController().signal)).rejects.toBeInstanceOf(CodexProtocolError)
    value.wire.interrupt()
    value.wire.close()
  })

  it.each([
    ['initialize response', null, 'initialize'],
    ['thread envelope', {}, 'thread/start'],
    ['thread object', { thread: [] }, 'thread/start'],
    ['thread ephemeral flag', { thread: { id: 'thread-1', ephemeral: false } }, 'thread/start'],
    ['thread id', { thread: { id: '', ephemeral: true } }, 'thread/start'],
  ])('rejects invalid %s', async (_label, response, stage) => {
    const value = harness((method) => {
      if (method === 'initialize') return stage === 'initialize' ? response : {}
      if (method === 'thread/start') return response
      return {}
    })
    const signal = new AbortController().signal
    if (stage === 'initialize') await expect(value.wire.initialize(signal)).rejects.toBeInstanceOf(CodexProtocolError)
    else {
      await value.wire.initialize(signal)
      await expect(value.wire.startThread('/workspace', signal)).rejects.toBeInstanceOf(CodexProtocolError)
    }
    value.wire.close()
  })

  it.each([
    ['turn response', null],
    ['turn envelope', {}],
    ['turn object', { turn: [] }],
    ['turn id', { turn: { id: 7 } }],
  ])('rejects invalid %s', async (_label, response) => {
    const value = harness((method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') return response
      return {}
    })
    const signal = await initialized(value)
    await expect(value.wire.runTurn('q', signal)).rejects.toBeInstanceOf(CodexProtocolError)
    value.wire.close()
  })

  it.each(['failed', 'interrupted', 'incomplete'])('rejects terminal status %s', async (status) => {
    const value = standard()
    const signal = await initialized(value)
    const pending = value.wire.runTurn('q', signal)
    complete(value, status)
    await expect(pending).rejects.toThrow(`status ${status}`)
    value.wire.close()
  })

  it('rejects malformed JSON and non-object frames', async () => {
    for (const line of [
      'not-json',
      '[]',
      'null',
      '{}',
      '{"jsonrpc":"2.0","id":"unknown","result":{}}',
    ]) {
      const value = standard()
      const pending = value.wire.initialize(new AbortController().signal)
      value.input.write(`${line}\n`)
      await expect(pending).rejects.toBeInstanceOf(CodexProtocolError)
      value.wire.close()
    }
  })

  it.each([
    [{ threadId: 4, turnId: 'turn-1', item: {} }, 'thread id'],
    [{ threadId: 'thread-1', turnId: '', item: {} }, 'turn id'],
    [{ threadId: 'thread-1', turnId: 'turn-1', item: null }, 'item'],
  ])('rejects malformed item notification %#', async (params, message) => {
    const value = standard()
    const signal = await initialized(value)
    const pending = value.wire.runTurn('q', signal)
    value.peer.notify('item/completed', params)
    await expect(pending).rejects.toThrow(message)
    value.wire.close()
  })

  it.each([
    [{ threadId: 4, turn: {} }, 'thread id'],
    [{ threadId: 'thread-1', turn: null }, 'turn'],
    [{ threadId: 'thread-1', turn: { id: '' } }, 'turn id'],
  ])('rejects malformed completion notification %#', async (params, message) => {
    const value = standard()
    const signal = await initialized(value)
    const pending = value.wire.runTurn('q', signal)
    value.peer.notify('turn/completed', params)
    await expect(pending).rejects.toThrow(message)
    value.wire.close()
  })

  it('accepts a matching early thread notification', async () => {
    const value = harness((method, _params, peer) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') {
        peer.notify('item/completed', {
          threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch' },
        })
        return { thread: { id: 'thread-1', ephemeral: true } }
      }
      return { turn: { id: 'turn-1' } }
    })
    await expect(initialized(value)).resolves.toBeInstanceOf(AbortSignal)
    value.wire.close()
  })

  it('routes non-Error notification failures to a protocol error', async () => {
    const value = standard()
    Object.assign(value.wire, { handleNotification: () => { throw 'non-error' } })
    const pending = value.wire.initialize(new AbortController().signal)
    value.peer.notify('item/completed', {})
    await expect(pending).rejects.toThrow('notification failed')
    value.wire.close()
  })

  it('rejects conflicting early and active thread/turn ids', async () => {
    const earlyThread = harness((method, _params, peer) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') {
        peer.notify('item/completed', {
          threadId: 'other-thread', turnId: 'turn-1', item: { type: 'webSearch' },
        })
        return { thread: { id: 'thread-1', ephemeral: true } }
      }
      return {}
    })
    const signal = new AbortController().signal
    await earlyThread.wire.initialize(signal)
    await expect(earlyThread.wire.startThread('/workspace', signal)).rejects.toThrow('conflicting thread')
    earlyThread.wire.close()

    const earlyTurn = harness((method, _params, peer) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
      if (method === 'turn/start') {
        peer.notify('item/completed', {
          threadId: 'thread-1', turnId: 'other-turn', item: { type: 'webSearch' },
        })
        return { turn: { id: 'turn-1' } }
      }
      return {}
    })
    const earlyTurnSignal = await initialized(earlyTurn)
    await expect(earlyTurn.wire.runTurn('q', earlyTurnSignal)).rejects.toThrow('conflicting turn')
    earlyTurn.wire.close()

    const activeThread = standard()
    const activeSignal = await initialized(activeThread)
    const activePending = activeThread.wire.runTurn('q', activeSignal)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    activeThread.peer.notify('item/completed', {
      threadId: 'other-thread', turnId: 'turn-1', item: { type: 'webSearch' },
    })
    await expect(activePending).rejects.toThrow('conflicting thread')
    activeThread.wire.close()

    const turn = standard()
    const turnSignal = await initialized(turn)
    const turnPending = turn.wire.runTurn('q', turnSignal)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    turn.peer.notify('item/completed', {
      threadId: 'thread-1', turnId: 'other-turn', item: { type: 'webSearch' },
    })
    await expect(turnPending).rejects.toThrow('conflicting turn')
    turn.wire.close()
  })

  it('rejects conflicting thread ids observed for one early turn', async () => {
    const value = standard()
    value.peer.notify('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch' },
    })
    value.peer.notify('item/completed', {
      threadId: 'thread-2', turnId: 'turn-1', item: { type: 'webSearch' },
    })
    await expect(value.wire.initialize(new AbortController().signal)).rejects.toThrow('conflicting thread')
    value.wire.close()
  })

  it('normalizes a non-Error notification failure and ignores unknown notifications', async () => {
    const value = standard()
    value.peer.notify('other', {})
    const signal = await initialized(value)
    const pending = value.wire.runTurn('q', signal)
    complete(value)
    await expect(pending).resolves.toEqual({ items: [] })
    value.wire.close()
  })
})
