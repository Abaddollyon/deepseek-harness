/**
 * First-use start for the per-Session stdio MCP servers of one browser provider.
 * The first Session that starts a server records its startup exchange. Later
 * Sessions receive the recorded replies for the same client messages and start
 * their own server when their client sends any other message.
 * @module
 */

import { isDeepStrictEqual } from 'node:util'
import type { JSONRPCMessage, Transport } from '@deepseek-ai/dsh-mcp-client'

type MessageHandler = NonNullable<Transport['onmessage']>
type MessageExtra = Parameters<MessageHandler>[1]
type SendOptions = Parameters<Transport['send']>[1]
type ResultResponse = Extract<JSONRPCMessage, { result: unknown }>
type ErrorResponse = Extract<JSONRPCMessage, { error: unknown }>
type RequestId = Extract<JSONRPCMessage, { method: string; id: unknown }>['id']

/** The reply fields of one server response. */
type Reply = Pick<ResultResponse, 'result'> | Pick<ErrorResponse, 'error'>

/** One client message of a recorded startup exchange. */
interface StartupStep {
  readonly method: string
  readonly params: unknown
  /** The server's reply to a request; absent for a notification. */
  readonly reply?: Reply
}

/** How one recording ended. */
type Recorded =
  /** A complete exchange that later Sessions replay. */
  | { readonly kind: 'replayable'; readonly steps: readonly StartupStep[] }
  /** A complete exchange that later Sessions cannot replay, so each starts its own server. */
  | { readonly kind: 'unreplayable' }
  /** The transport closed before its exchange completed; the next Session records again. */
  | { readonly kind: 'incomplete' }

/** Whether a transport answers from the record, records a new exchange, or only starts its server. */
type Claim =
  | { readonly kind: 'replay'; readonly steps: readonly StartupStep[] }
  | { readonly kind: 'record'; readonly finish: (recorded: Recorded) => void }
  | { readonly kind: 'start' }

/** Record access granted by {@link SharedServerStart} to its transports. */
interface StartupRecord {
  readonly label: string
  claim(signal: AbortSignal): Promise<Claim>
  invalidate(): void
}

/** One exchange being recorded by the transport whose server answers it. */
interface Recording {
  readonly steps: RecordedStep[]
  /** Recorded requests still waiting for their reply. */
  readonly pending: Map<RequestId, RecordedStep>
  replayable: boolean
  readonly finish: (recorded: Recorded) => void
}

/** One step while its reply is still being recorded. */
interface RecordedStep {
  readonly method: string
  readonly params: unknown
  reply?: Reply
}

/** A client message answered from the record, sent to the server once it starts. */
interface AnsweredMessage {
  readonly message: JSONRPCMessage
  readonly method: string
  readonly id?: RequestId
  readonly reply?: Reply
}

type State =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly steps: readonly StartupStep[]; next: number }
  | { readonly kind: 'live'; readonly server: Transport }
  | { readonly kind: 'closed' }

/** Read the reply fields of one response. */
function replyOf(message: ResultResponse | ErrorResponse): Reply {
  return 'result' in message ? { result: message.result } : { error: message.error }
}

/** Build the response that answers one request id with recorded reply fields. */
function responseTo(id: RequestId, reply: Reply): JSONRPCMessage {
  return 'result' in reply
    ? { jsonrpc: '2.0', id, result: structuredClone(reply.result) }
    : { jsonrpc: '2.0', id, error: structuredClone(reply.error) }
}

/** Whether a client message is the one a recorded step expects. */
function expected(step: StartupStep, message: JSONRPCMessage): boolean {
  return 'method' in message && message.method === step.method
    && ('id' in message) === (step.reply !== undefined)
    && isDeepStrictEqual(message.params, step.params)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The tools capability of a recorded `initialize` result, if it declares one. */
function initializedTools(step: StartupStep): Readonly<Record<string, unknown>> | undefined {
  if (step.method !== 'initialize' || step.reply === undefined || !('result' in step.reply)) return undefined
  const capabilities = step.reply.result.capabilities
  return isRecord(capabilities) && isRecord(capabilities.tools) ? capabilities.tools : undefined
}

/**
 * Whether a replaying client can learn that a started server lists other tools. The MCP
 * client handles `notifications/tools/list_changed` only when initialization declared
 * `tools.listChanged`, and the replay can declare it only in an `initialize` result.
 * @param steps - one completed startup exchange.
 * @returns whether the exchange includes an `initialize` result that declares tools.
 */
function announcesToolChanges(steps: readonly StartupStep[]): boolean {
  return steps.some(step => initializedTools(step) !== undefined)
}

/**
 * The reply a replaying client receives for one recorded request. A replayed `initialize`
 * result declares `tools.listChanged`, so the client lists its tools again when the
 * Session's started server lists other tools than the record.
 */
function replayedReply(step: StartupStep, reply: Reply): Reply {
  const tools = initializedTools(step)
  if (tools === undefined || !('result' in reply) || !isRecord(reply.result.capabilities)) return reply
  return { result: { ...reply.result, capabilities: { ...reply.result.capabilities, tools: { ...tools, listChanged: true } } } }
}

/**
 * Owns the startup exchange recorded for one provider's fixed server command.
 * The record assumes that the server's startup replies depend only on that
 * command, never on a Session's working directory. After one completed exchange
 * that cannot be replayed, later Sessions start their own servers without waiting.
 */
export class SharedServerStart {
  private steps: readonly StartupStep[] | undefined
  private unreplayable = false
  private recording: Promise<void> | undefined
  private readonly record: StartupRecord

  /**
   * @param label - provider name used in diagnostics.
   * @param warn - reports a started server whose startup replies differ from the record, and an exchange that cannot be replayed.
   */
  constructor(label: string, private readonly warn: (message: string) => void) {
    this.record = {
      label,
      claim: signal => this.claim(signal),
      invalidate: () => {
        this.steps = undefined
        warn(`${label}: a started browser server answered its startup requests differently from the recorded exchange; the next Session records a new one`)
      },
    }
  }

  /**
   * Wrap one Session's server transport.
   * @param open - creates the configured stdio transport for that Session's own server.
   * @param timeoutMs - time a started server has to answer the startup requests replayed to it; the Session's tool-call timeout.
   * @returns a transport that answers from the record while it can and otherwise starts and forwards to the server.
   */
  wrap(open: () => Transport, timeoutMs: number): DeferredServerTransport {
    return new DeferredServerTransport(this.record, open, timeoutMs)
  }

  /** Wait for an exchange being recorded, then replay the record, record a new one, or start without one. */
  private async claim(signal: AbortSignal): Promise<Claim> {
    while (this.recording !== undefined) await unlessAborted(this.recording, signal)
    signal.throwIfAborted()
    if (this.unreplayable) return { kind: 'start' }
    if (this.steps !== undefined) return { kind: 'replay', steps: this.steps }
    const recorded: PromiseWithResolvers<void> = Promise.withResolvers()
    this.recording = recorded.promise
    // Each recording transport calls `finish` exactly once: from commit, from closure, or from a start closed while claiming.
    return {
      kind: 'record',
      finish: (outcome) => {
        if (outcome.kind === 'replayable') this.steps = outcome.steps
        else if (outcome.kind === 'unreplayable') {
          this.unreplayable = true
          this.warn(`${this.record.label}: the browser server's startup exchange cannot be replayed; each later Session starts its own server during activation`)
        }
        this.recording = undefined
        recorded.resolve()
      },
    }
  }
}

/** Settle like a promise, or reject with the signal's reason if it aborts first. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason as Error) }
    void promise.then((value) => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
    })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * One Session's stdio server transport. It answers client messages that match
 * the recorded startup exchange in order; the first other message starts the
 * Session's own server, sends it the answered messages, withholds the replies
 * the client already received, and forwards all later traffic. That server must
 * answer the replayed requests within the configured timeout, or the transport
 * closes and the triggering message fails. Without a record it starts the
 * server immediately and records the exchange until {@link commit}, unless the
 * provider's exchange cannot be replayed. A started server's close closes this
 * transport.
 */
export class DeferredServerTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: MessageHandler

  private state: State = { kind: 'new' }
  private readonly stopped = new AbortController()
  private outbound: Promise<void> = Promise.resolve()
  private readonly answered: AnsweredMessage[] = []
  private readonly withheld = new Map<RequestId, PromiseWithResolvers<Reply | undefined>>()
  private recording: Recording | undefined
  private supportedVersions: string[] | undefined
  private protocolVersion: string | undefined
  private closeReported = false

  /**
   * @param record - the provider's shared startup record.
   * @param open - creates the configured transport for this Session's own server.
   * @param timeoutMs - time a started server has to answer the replayed startup requests.
   */
  constructor(
    private readonly record: StartupRecord,
    private readonly open: () => Transport,
    private readonly timeoutMs: number,
  ) {}

  /** Process id of the started server, or `null` before it starts; its presence selects stdio protocol negotiation. */
  get pid(): number | null {
    const server = this.state.kind === 'live' ? this.state.server : undefined
    return server !== undefined && 'pid' in server && typeof server.pid === 'number' ? server.pid : null
  }

  /** The server inherits the Host's standard error, so no stream is piped. */
  get stderr(): null {
    return null
  }

  /**
   * Answer from the record, or start the server and record its exchange when no record exists.
   * Waits while another Session of the provider records one; starts the server without recording
   * once the provider's exchange cannot be replayed.
   */
  async start(): Promise<void> {
    const claim = await this.record.claim(this.stopped.signal)
    if (this.stopped.signal.aborted) {
      if (claim.kind === 'record') claim.finish({ kind: 'incomplete' })
      throw this.disconnected()
    }
    if (claim.kind === 'replay') {
      this.state = { kind: 'replay', steps: claim.steps, next: 0 }
      return
    }
    if (claim.kind === 'record') this.recording = { steps: [], pending: new Map(), replayable: true, finish: claim.finish }
    await this.startServer()
  }

  /**
   * Answer, queue, or forward one client message in send order.
   * @param message - client request, notification, or response.
   * @param options - SDK send options, forwarded to the started server.
   * @returns settlement after the message was answered or handed to the server.
   */
  send(message: JSONRPCMessage, options?: SendOptions): Promise<void> {
    const sent = this.outbound.then(() => this.dispatch(message, options))
    // The queue only orders sends; each caller observes its own failure through `sent`.
    this.outbound = sent.catch(() => undefined)
    return sent
  }

  /**
   * Keep the exchange recorded so far for later Sessions. It is replayable only when every
   * recorded request has its reply, the server sent nothing else, and an `initialize` result
   * declares tools, so a replaying client can learn of a changed tool list. Otherwise later
   * Sessions of the provider start their own servers.
   */
  commit(): void {
    const recording = this.recording
    if (recording === undefined) return
    this.recording = undefined
    const replayable = recording.replayable && recording.pending.size === 0 && announcesToolChanges(recording.steps)
    recording.finish(replayable ? { kind: 'replayable', steps: structuredClone(recording.steps) } : { kind: 'unreplayable' })
  }

  /** Forward the negotiated versions to the server once it starts. */
  setSupportedProtocolVersions(versions: string[]): void {
    this.supportedVersions = versions
    if (this.state.kind === 'live') this.state.server.setSupportedProtocolVersions?.(versions)
  }

  /** Forward the negotiated protocol version to the server once it starts. */
  setProtocolVersion(version: string): void {
    this.protocolVersion = version
    if (this.state.kind === 'live') this.state.server.setProtocolVersion?.(version)
  }

  /** Close the started server, if any, and report closure once. */
  async close(): Promise<void> {
    const state = this.state
    this.state = { kind: 'closed' }
    this.stopped.abort(this.disconnected())
    if (state.kind === 'live') await state.server.close()
    this.reportClose()
  }

  private async dispatch(message: JSONRPCMessage, options: SendOptions): Promise<void> {
    const state = this.state
    if (state.kind === 'replay') {
      const step = state.steps[state.next]
      if (step !== undefined && expected(step, message)) {
        state.next += 1
        const id = 'id' in message ? message.id : undefined
        this.answered.push({
          message,
          method: step.method,
          ...id === undefined ? {} : { id },
          ...step.reply === undefined ? {} : { reply: step.reply },
        })
        if (id !== undefined && step.reply !== undefined) this.deliverLater(responseTo(id, replayedReply(step, step.reply)))
        return
      }
      await this.startServer()
    }
    const current = this.state
    if (current.kind !== 'live') throw this.disconnected()
    this.recordSent(message)
    await current.server.send(message, options)
  }

  private async startServer(): Promise<void> {
    const expired = new AbortController()
    const timer = setTimeout(() => {
      expired.abort(new Error(`${this.record.label}: the browser server did not answer its startup requests within ${this.timeoutMs} ms`))
    }, this.timeoutMs)
    timer.unref()
    try {
      const server = this.open()
      this.state = { kind: 'live', server }
      server.onmessage = (message, extra) => { this.receive(message, extra) }
      server.onerror = (error) => { this.onerror?.(error) }
      server.onclose = () => { this.reportClose() }
      if (this.supportedVersions !== undefined) server.setSupportedProtocolVersions?.(this.supportedVersions)
      if (this.protocolVersion !== undefined) server.setProtocolVersion?.(this.protocolVersion)
      await unlessAborted(server.start(), expired.signal)
      let toolsChanged = false
      let changed = false
      for (const { message, method, id, reply } of this.answered.splice(0)) {
        if (id === undefined || reply === undefined) {
          await unlessAborted(server.send(message), expired.signal)
          continue
        }
        const withheld: PromiseWithResolvers<Reply | undefined> = Promise.withResolvers()
        this.withheld.set(id, withheld)
        await unlessAborted(server.send(message), expired.signal)
        const actual = await unlessAborted(withheld.promise, expired.signal)
        if (actual === undefined) throw this.disconnected()
        if (isDeepStrictEqual(actual, reply)) continue
        changed = true
        if (method === 'tools/list') toolsChanged = true
      }
      if (changed) this.record.invalidate()
      // The client lists its tools again through `send`, so the message that started this
      // server reaches it first; a call to a tool the server no longer lists gets its error reply.
      if (toolsChanged) this.onmessage?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    } catch (error) {
      await this.close()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private receive(message: JSONRPCMessage, extra: MessageExtra): void {
    if ('method' in message) {
      if (this.recording !== undefined) this.recording.replayable = false
    } else if (message.id !== undefined) {
      const withheld = this.withheld.get(message.id)
      if (withheld !== undefined) {
        this.withheld.delete(message.id)
        withheld.resolve(replyOf(message))
        return
      }
      this.recordReply(message.id, message)
    }
    this.onmessage?.(message, extra)
  }

  private recordSent(message: JSONRPCMessage): void {
    const recording = this.recording
    if (recording === undefined) return
    if (!('method' in message)) {
      recording.replayable = false
      return
    }
    const step: RecordedStep = { method: message.method, params: message.params }
    recording.steps.push(step)
    if ('id' in message) recording.pending.set(message.id, step)
  }

  private recordReply(id: RequestId, message: ResultResponse | ErrorResponse): void {
    const pending = this.recording?.pending
    const step = pending?.get(id)
    if (pending === undefined || step === undefined) return
    pending.delete(id)
    step.reply = replyOf(message)
  }

  private deliverLater(message: JSONRPCMessage): void {
    setImmediate(() => {
      if (this.state.kind !== 'closed') this.onmessage?.(message)
    })
  }

  private reportClose(): void {
    this.state = { kind: 'closed' }
    this.stopped.abort(this.disconnected())
    const recording = this.recording
    this.recording = undefined
    recording?.finish({ kind: 'incomplete' })
    for (const withheld of this.withheld.values()) withheld.resolve(undefined)
    this.withheld.clear()
    if (this.closeReported) return
    this.closeReported = true
    this.onclose?.()
  }

  private disconnected(): Error {
    return new Error(`${this.record.label}: the browser server transport is not connected`)
  }
}
