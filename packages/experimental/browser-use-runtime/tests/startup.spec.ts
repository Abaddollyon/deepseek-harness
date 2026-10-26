import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import type { JSONRPCMessage, Transport } from '@deepseek-ai/dsh-mcp-client'
import { SharedServerStart } from '../src/startup.ts'
import type { DeferredServerTransport } from '../src/startup.ts'

type Responder = (message: JSONRPCMessage) => JSONRPCMessage | undefined

const INITIALIZE: JSONRPCMessage = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } }
const INITIALIZED: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/initialized' }
const LIST: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
const CALL: JSONRPCMessage = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'visit' } }
/** A replay timeout that no started server in these tests reaches. */
const TIMEOUT_MS = 60_000

/** Answers startup requests like a server whose listing names its own generation. */
function server(generation: number): Responder {
  return (message) => {
    if (!('method' in message) || !('id' in message)) return undefined
    switch (message.method) {
      case 'initialize': return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }
      case 'tools/list': return { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'visit', description: `server ${generation}`, inputSchema: { type: 'object' } }] } }
      default: return { jsonrpc: '2.0', id: message.id, result: { content: [], generation } }
    }
  }
}

/** In-process server side of one stdio transport. */
class FakeServer implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: Transport['onmessage']
  readonly received: JSONRPCMessage[] = []
  readonly versions: string[] = []
  started = 0
  closed = 0

  constructor(private readonly respond: Responder) {}

  start(): Promise<void> {
    this.started += 1
    return Promise.resolve()
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.received.push(message)
    const reply = this.respond(message)
    if (reply !== undefined) queueMicrotask(() => { this.onmessage?.(reply) })
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed += 1
    this.onclose?.()
    return Promise.resolve()
  }

  /** Deliver a server-initiated message. */
  push(message: JSONRPCMessage): void {
    this.onmessage?.(message)
  }
}

/** Stdio-like server with a process id that records protocol-version calls. */
class VersionedServer extends FakeServer {
  constructor(respond: Responder, readonly pid: number) {
    super(respond)
  }

  setSupportedProtocolVersions(versions: string[]): void { this.versions.push(`supported:${versions.join(',')}`) }
  setProtocolVersion(version: string): void { this.versions.push(`negotiated:${version}`) }
}

/** A server factory whose servers all answer with `respond`, with the servers it opened. */
function factory(respond: Responder = server(1)) {
  const servers: FakeServer[] = []
  const open = (): FakeServer => {
    const opened = new FakeServer(respond)
    servers.push(opened)
    return opened
  }
  return { servers, open }
}

/** Client side of one transport: collects delivered messages and closure. */
function client(transport: DeferredServerTransport) {
  const received: JSONRPCMessage[] = []
  const closed = vi.fn()
  transport.onmessage = (message) => { received.push(message) }
  transport.onclose = closed
  return { received, closed }
}

/** Drive the SDK's startup exchange and commit it. */
async function connect(transport: DeferredServerTransport): Promise<void> {
  await transport.start()
  for (const message of [INITIALIZE, INITIALIZED, LIST]) await transport.send(message)
  await nextTurn()
}

/** A provider whose first transport recorded one startup exchange from generation 1. */
async function recorded() {
  const warn = vi.fn()
  const shared = new SharedServerStart('fixture', warn)
  const servers: FakeServer[] = []
  const open = (respond: Responder = server(servers.length + 1)) => () => {
    const opened = new VersionedServer(respond, 4000 + servers.length)
    servers.push(opened)
    return opened
  }
  const recorder = shared.wrap(open(), TIMEOUT_MS)
  client(recorder)
  await connect(recorder)
  recorder.commit()
  return { shared, servers, open, warn, recorder }
}

describe('first-use server transport', () => {
  it('answers a later Session from the record and starts its server only at the first other message', async () => {
    const { shared, servers, open, warn } = await recorded()
    const later = shared.wrap(open(), TIMEOUT_MS)
    const { received } = client(later)
    expect(later.pid).toBeNull()
    expect(later.stderr).toBeNull()
    later.setSupportedProtocolVersions(['2025-11-25'])
    await connect(later)
    later.setProtocolVersion('2025-11-25')
    expect(servers).toHaveLength(1)
    expect(received.map(message => 'id' in message ? message.id : undefined)).toEqual([0, 1])
    expect(received[1]).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'visit', description: 'server 1', inputSchema: { type: 'object' } }] } })
    // The replayed initialization declares tool-list changes, so the client handles the notification below.
    expect(received[0]).toMatchObject({ result: { capabilities: { tools: { listChanged: true } } } })

    await later.send(CALL)
    await nextTurn()
    expect(servers).toHaveLength(2)
    const started = servers[1]!
    expect(later.pid).toBe(4001)
    // The started server receives the answered prefix in order; its replies to those requests stay withheld.
    expect(started.received).toEqual([INITIALIZE, INITIALIZED, LIST, CALL])
    expect(started.versions).toEqual(['supported:2025-11-25', 'negotiated:2025-11-25'])
    expect(received.map(message => 'id' in message ? message.id : 'method' in message ? message.method : undefined)).toEqual([0, 1, 'notifications/tools/list_changed', 2])
    // Generation 2 lists a different description: the record is dropped and the client re-lists.
    expect(warn).toHaveBeenCalledOnce()
    later.setProtocolVersion('2025-06-18')
    expect(started.versions.at(-1)).toBe('negotiated:2025-06-18')
    const next = shared.wrap(open(), TIMEOUT_MS)
    client(next)
    await next.start()
    expect(servers).toHaveLength(3)
  })

  it('keeps the record and the server when the started server answers as recorded within the timeout', async () => {
    const { shared, servers, warn } = await recorded()
    const later = shared.wrap(() => {
      const opened = new FakeServer(server(1))
      servers.push(opened)
      return opened
    }, 20)
    const { received } = client(later)
    await connect(later)
    await later.send(CALL)
    await nextTurn()
    expect(later.pid).toBeNull()
    expect(received.map(message => 'id' in message ? message.id : undefined)).toEqual([0, 1, 2])
    expect(warn).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(servers[1]!.closed).toBe(0)
    const next = shared.wrap(() => { throw new Error('a replayed Session must not start a server') }, TIMEOUT_MS)
    client(next)
    await connect(next)
  })

  it('reports a changed initialize reply without asking the client to re-list tools', async () => {
    const { shared, open, warn } = await recorded()
    const changed: Responder = message => 'method' in message && message.method === 'initialize' && 'id' in message
      ? { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '2' } } }
      : server(1)(message)
    const later = shared.wrap(open(changed), TIMEOUT_MS)
    const { received } = client(later)
    await connect(later)
    await later.send(CALL)
    await nextTurn()
    expect(warn).toHaveBeenCalledOnce()
    expect(received.some(message => 'method' in message)).toBe(false)
  })

  it('starts the server when the client diverges from the record and forwards server messages', async () => {
    const { shared, servers, open } = await recorded()
    const later = shared.wrap(open(server(1)), TIMEOUT_MS)
    const { received } = client(later)
    const errors: Error[] = []
    later.onerror = (error) => { errors.push(error) }
    await later.start()
    await later.send({ ...INITIALIZE, params: { protocolVersion: '2024-11-05' } })
    await nextTurn()
    const started = servers[1]!
    expect(started.received).toEqual([{ ...INITIALIZE, params: { protocolVersion: '2024-11-05' } }])
    started.push({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })
    started.push({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } })
    started.onerror?.(new Error('stdin closed'))
    expect(received.map(message => 'method' in message ? message.method : 'error' in message ? 'error' : 'result')).toEqual(['result', 'notifications/message', 'error'])
    expect(errors.map(error => error.message)).toEqual(['stdin closed'])
  })

  it('fails the triggering message and closes once when the server cannot start or closes before replying', async () => {
    const { shared } = await recorded()
    const unavailable = shared.wrap(() => { throw new Error('spawn ENOENT') }, TIMEOUT_MS)
    const first = client(unavailable)
    await connect(unavailable)
    await expect(unavailable.send(CALL)).rejects.toThrow('spawn ENOENT')
    await expect(unavailable.send(CALL)).rejects.toThrow('fixture: the browser server transport is not connected')
    expect(first.closed).toHaveBeenCalledOnce()

    const silent = new FakeServer(() => undefined)
    const closing = shared.wrap(() => silent, TIMEOUT_MS)
    const second = client(closing)
    await connect(closing)
    const pending = closing.send(CALL)
    await vi.waitFor(() => { expect(silent.received).toHaveLength(1) })
    await silent.close()
    await expect(pending).rejects.toThrow('not connected')
    await closing.close()
    expect(second.closed).toHaveBeenCalledOnce()
  })

  it('closes a started server that does not answer the replayed requests within the timeout and fails the triggering message', async () => {
    const { shared } = await recorded()
    const silent = new FakeServer(() => undefined)
    const later = shared.wrap(() => silent, 20)
    const { closed } = client(later)
    await connect(later)
    await expect(later.send(CALL)).rejects.toThrow('fixture: the browser server did not answer its startup requests within 20 ms')
    expect(silent.received).toEqual([INITIALIZE])
    expect(silent.closed).toBe(1)
    expect(closed).toHaveBeenCalledOnce()
    await expect(later.send(CALL)).rejects.toThrow('not connected')
  })

  it('drops a recorded reply when the client closes before its delivery', async () => {
    const { shared } = await recorded()
    const later = shared.wrap(() => { throw new Error('unused') }, TIMEOUT_MS)
    const { received, closed } = client(later)
    await later.start()
    await later.send(INITIALIZE)
    await later.close()
    await later.close()
    await nextTurn()
    expect(received).toEqual([])
    expect(closed).toHaveBeenCalledOnce()
    await expect(later.send(LIST)).rejects.toThrow('not connected')
  })
})

describe('recording the startup exchange', () => {
  it('starts every later server at once, without recording, after a completed exchange that cannot be replayed', async () => {
    const undeclared: Responder = message => 'method' in message && message.method === 'initialize' && 'id' in message
      ? { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }
      : server(1)(message)
    const unlisted: Responder = message => 'id' in message && 'method' in message && message.method === 'tools/list' ? undefined : server(1)(message)
    const cases: { respond: Responder; disturb: (opened: FakeServer, transport: DeferredServerTransport) => void | Promise<void> }[] = [
      // The server sends a message of its own.
      { respond: server(1), disturb: (opened) => { opened.push({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }) } },
      // The client answers a server request.
      { respond: server(1), disturb: async (_opened, transport) => { await transport.send({ jsonrpc: '2.0', id: 'server-1', result: {} }) } },
      // A recorded request still waits for its reply; a reply to a request the record never saw does not complete it.
      { respond: unlisted, disturb: (opened) => { opened.push({ jsonrpc: '2.0', id: 99, result: {} }) } },
      // Initialization declares no tools, so a replaying client could not learn that its tools changed.
      { respond: undeclared, disturb: () => {} },
    ]
    for (const { respond, disturb } of cases) {
      const warn = vi.fn()
      const shared = new SharedServerStart('fixture', warn)
      const { servers, open } = factory(respond)
      const recorder = shared.wrap(open, TIMEOUT_MS)
      client(recorder)
      await connect(recorder)
      await disturb(servers[0]!, recorder)
      recorder.commit()
      recorder.commit()
      // The second later transport starts while the first has not committed.
      for (const later of [shared.wrap(open, TIMEOUT_MS), shared.wrap(open, TIMEOUT_MS)]) {
        client(later)
        await later.start()
      }
      expect(servers).toHaveLength(3)
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('startup exchange cannot be replayed'))
    }
  })

  it('holds later transports while one records and releases them when it closes or they close', async () => {
    const shared = new SharedServerStart('fixture', vi.fn())
    const { servers, open } = factory()
    const recorder = shared.wrap(open, TIMEOUT_MS)
    client(recorder)
    await recorder.start()
    const abandoned = shared.wrap(open, TIMEOUT_MS)
    const abandonedStart = abandoned.start()
    const waiting = shared.wrap(open, TIMEOUT_MS)
    let waited = false
    const waitingStart = waiting.start().then(() => { waited = true })
    await nextTurn()
    expect(waited).toBe(false)
    await abandoned.close()
    await expect(abandonedStart).rejects.toThrow('not connected')
    await recorder.close()
    await waitingStart
    expect(servers).toHaveLength(2)
  })

  it('releases the recording claim when the transport closes as it starts', async () => {
    const shared = new SharedServerStart('fixture', vi.fn())
    const { servers, open } = factory()
    const closing = shared.wrap(open, TIMEOUT_MS)
    const starting = closing.start()
    await closing.close()
    await expect(starting).rejects.toThrow('not connected')
    const next = shared.wrap(open, TIMEOUT_MS)
    await next.start()
    expect(servers).toHaveLength(1)
  })

  it('rejects a replaying start that closes as it starts', async () => {
    const { shared, servers } = await recorded()
    const closing = shared.wrap(() => { throw new Error('unused') }, TIMEOUT_MS)
    const starting = closing.start()
    await closing.close()
    await expect(starting).rejects.toThrow('not connected')
    expect(servers).toHaveLength(1)
  })

  it('rejects messages sent before the transport starts', async () => {
    const transport = new SharedServerStart('fixture', vi.fn()).wrap(() => new FakeServer(server(1)), TIMEOUT_MS)
    await expect(transport.send(INITIALIZE)).rejects.toThrow('fixture: the browser server transport is not connected')
  })
})
