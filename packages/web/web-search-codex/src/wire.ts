/** Narrow Codex app-server JSON-RPC client for one ephemeral web-search turn. */

import type { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

type JsonObject = Record<string, unknown>

/** Protocol validation failure safe for provider-level classification. */
export class CodexProtocolError extends Error {}

/** Structured notifications collected for one completed search turn. */
export interface CodexSearchTurnResult {
  readonly items: readonly JsonObject[]
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexProtocolError(`Codex app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodexProtocolError(`Codex app-server returned invalid ${label}`)
  }
  return value
}

function abortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Codex web search was cancelled')
}

function prompt(query: string): string {
  return [
    'Use the built-in web search exactly once.',
    `Search exactly as supplied: ${query}`,
    'Use no other tools; return source URLs and snippets.',
  ].join(' ')
}

/** One process-local connection with a single thread and turn. */
export class CodexSearchWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private readonly itemsByTurn = new Map<string, JsonObject[]>()
  private readonly completedByTurn = new Map<string, JsonObject>()
  private readonly threadByTurn = new Map<string, string>()
  private threadId: string | undefined
  private turnId: string | undefined
  private turnCompleted: PromiseWithResolvers<JsonObject> | undefined
  private closed = false

  /** Create a protocol client over caller-owned streams. */
  constructor(input: Readable, output: Writable) {
    this.transport = new JsonRpcLineTransport(input, output)
    void this.fatal.promise.catch(() => undefined)
    this.transport.onRequest((method) => {
      if (method === 'currentTime/read') {
        return Promise.resolve({ currentTimeAt: Math.floor(Date.now() / 1_000) })
      }
      return Promise.reject(
        new CodexProtocolError(`Codex web search rejects server request ${JSON.stringify(method)}`),
      )
    })
    this.transport.onMalformed(() => {
      this.rejectFatal(new CodexProtocolError('Codex app-server returned a malformed JSON-RPC frame'))
    })
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.rejectFatal(error instanceof Error ? error : new CodexProtocolError('Codex notification failed'))
      }
    })
  }

  /** Begin consuming frames. Idempotent through the shared transport. */
  start(): void {
    this.transport.start()
  }

  /**
   * Perform initialize/initialized and flush the notification.
   * @param signal - Cancellation for the protocol phase.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.0.1' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, signal), signal), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
  }

  /**
   * Create the ephemeral, non-interactive, read-only live-search thread.
   * @param cwd - Existing working directory supplied to Codex.
   * @param signal - Cancellation for the protocol phase.
   */
  async startThread(cwd: string, signal: AbortSignal): Promise<void> {
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { web_search: 'live', tools: { web_search: true } },
    }, signal), signal), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    if (thread.ephemeral !== true) {
      throw new CodexProtocolError('Codex app-server did not create an ephemeral thread')
    }
    const threadId = identifier(thread.id, 'thread/start thread id')
    for (const seen of this.threadByTurn.values()) {
      if (seen !== threadId) throw new CodexProtocolError('Codex app-server returned a conflicting thread id')
    }
    this.threadId = threadId
  }

  /**
   * Start one search turn and await its strictly correlated completion.
   * @param query - Exact user query embedded in the constrained prompt.
   * @param signal - Cancellation for the turn and completion wait.
   * @returns Structured completed items for provider normalization.
   */
  async runTurn(query: string, signal: AbortSignal): Promise<CodexSearchTurnResult> {
    const threadId = this.threadId
    if (threadId === undefined) {
      throw new CodexProtocolError('Codex web search turn started before thread creation')
    }
    const completion = Promise.withResolvers<JsonObject>()
    this.turnCompleted = completion
    const response = object(await this.guarded(this.transport.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt(query), text_elements: [] }],
    }, signal), signal), 'turn/start response')
    const turn = object(response.turn, 'turn/start turn')
    const turnId = identifier(turn.id, 'turn/start turn id')
    for (const observedTurn of this.threadByTurn.keys()) {
      if (observedTurn !== turnId) {
        throw new CodexProtocolError('Codex app-server returned a conflicting turn id')
      }
    }
    this.turnId = turnId
    const early = this.completedByTurn.get(turnId)
    if (early !== undefined) completion.resolve(early)
    const terminal = await this.guarded(completion.promise, signal)
    if (terminal.status !== 'completed') {
      throw new CodexProtocolError(`Codex web search turn ended with status ${String(terminal.status)}`)
    }
    return { items: this.itemsByTurn.get(turnId) ?? [] }
  }

  /** Send a best-effort interrupt when both correlated ids are known. */
  interrupt(): void {
    if (this.closed || this.threadId === undefined || this.turnId === undefined) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    }).catch(() => undefined)
  }

  /** Detach listeners and reject pending RPC requests. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
  }

  private rejectFatal(error: Error): void {
    this.fatal.reject(error)
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      void pending.catch(() => undefined)
      throw abortReason(signal.reason)
    }
    let rejectAbort!: (error: Error) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const onAbort = (): void => { rejectAbort(abortReason(signal.reason)) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([pending, this.fatal.promise, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private correlate(threadId: string, turnId: string): void {
    if (this.threadId !== undefined && threadId !== this.threadId) {
      throw new CodexProtocolError('Codex app-server returned a conflicting thread id')
    }
    if (this.turnId !== undefined && turnId !== this.turnId) {
      throw new CodexProtocolError('Codex app-server returned a conflicting turn id')
    }
    const observedThread = this.threadByTurn.get(turnId)
    if (observedThread !== undefined && observedThread !== threadId) {
      throw new CodexProtocolError('Codex app-server returned a conflicting thread id')
    }
    this.threadByTurn.set(turnId, threadId)
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === 'item/completed') {
      const threadId = identifier(params.threadId, 'item/completed thread id')
      const turnId = identifier(params.turnId, 'item/completed turn id')
      this.correlate(threadId, turnId)
      const item = object(params.item, 'item/completed item')
      if (item.type !== 'webSearch' && item.type !== 'agentMessage') return
      this.itemsByTurn.set(turnId, [...this.itemsByTurn.get(turnId) ?? [], item])
      return
    }
    if (method !== 'turn/completed') return
    const threadId = identifier(params.threadId, 'turn/completed thread id')
    const turn = object(params.turn, 'turn/completed turn')
    const turnId = identifier(turn.id, 'turn/completed turn id')
    this.correlate(threadId, turnId)
    this.completedByTurn.set(turnId, turn)
    if (turnId === this.turnId) this.turnCompleted?.resolve(turn)
  }
}
