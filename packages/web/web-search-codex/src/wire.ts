/** Minimal Codex app-server client for one ephemeral web-search turn. */

import type { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

type JsonObject = Record<string, unknown>

/** Structured web-search observation from one completed Codex turn. */
export interface CodexSearchTurnResult {
  readonly items: readonly JsonObject[]
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Codex app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error('Codex web search was cancelled')
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Codex app-server returned invalid ${label}`)
  }
  return value
}

function prompt(query: string): string {
  return 'Use the built-in web search exactly once. Search exactly as supplied: ' + query + '. Use no other tools; return source URLs and snippets.'
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let rejectCancelled!: (reason: Error) => void
  const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject })
  const onAbort = (): void => { rejectCancelled(thrown(signal.reason)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** One process-local app-server connection with one thread and one turn. */
export class CodexSearchWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private readonly itemsByTurn = new Map<string, JsonObject[]>()
  private readonly completedByTurn = new Map<string, JsonObject>()
  private threadId: string | undefined
  private turnId: string | undefined
  private turnCompleted: PromiseWithResolvers<JsonObject> | undefined
  private closed = false

  /** Create an app-server protocol client over caller-owned streams. */
  constructor(input: Readable, output: Writable) {
    this.transport = new JsonRpcLineTransport(input, output)
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method) => {
      if (method === 'currentTime/read') {
        return Promise.resolve({ currentTimeAt: Math.floor(Date.now() / 1_000) })
      }
      return Promise.reject(
        new Error(`Codex web search rejects interactive request ${JSON.stringify(method)}`),
      )
    })
    this.transport.onMalformed(() => {
      this.fatal.reject(new Error('Codex app-server returned a malformed JSON-RPC frame'))
    })
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.fatal.reject(error)
      }
    })
  }

  /** Start consuming JSON-RPC frames. */
  start(): void {
    this.transport.start()
  }

  /** Perform the official initialize/initialized handshake.
   * @param signal - operation cancellation signal.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.0.1' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, signal), signal), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
  }

  /** Create one ephemeral, non-interactive, read-only thread with native web search configured.
   * @param cwd - thread working directory.
   * @param request - provider-neutral batch controls mapped into native configuration.
   * @param signal - operation cancellation signal.
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
    if (thread.ephemeral !== true) throw new Error('Codex app-server did not create an ephemeral thread')
    this.threadId = identifier(thread.id, 'thread/start thread id')
  }

  /** Run one turn containing all deduplicated queries and collect only structured web-search items.
   * @param request - deduplicated ordered queries and search controls.
   * @param signal - operation cancellation signal.
   * @returns structured native search result items plus terminal usage.
   */
  async runTurn(query: string, signal: AbortSignal): Promise<CodexSearchTurnResult> {
    const threadId = this.threadId
    if (threadId === undefined) throw new Error('Codex web search turn started before thread creation')
    const completion = Promise.withResolvers<JsonObject>()
    this.turnCompleted = completion
    const response = object(await this.guarded(this.transport.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt(query), text_elements: [] }],
    }, signal), signal), 'turn/start response')
    const turn = object(response.turn, 'turn/start turn')
    const turnId = identifier(turn.id, 'turn/start turn id')
    this.turnId = turnId
    const early = this.completedByTurn.get(turnId)
    if (early !== undefined) completion.resolve(early)
    const terminal = await this.guarded(completion.promise, signal)
    if (terminal.status !== 'completed') {
      throw new Error(`Codex web search turn ended with status ${String(terminal.status)}`)
    }
    return { items: this.itemsByTurn.get(turnId) ?? [] }
  }

  /** Request best-effort remote cancellation when both protocol ids are known. */
  interrupt(): void {
    if (this.closed || this.threadId === undefined || this.turnId === undefined) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    }).catch(() => {})
  }

  /** Detach protocol listeners and reject pending protocol requests. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      void pending.catch(() => {})
      throw thrown(signal.reason)
    }
    return await abortable(Promise.race([pending, this.fatal.promise]), signal)
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === 'item/completed') {
      const threadId = identifier(params.threadId, 'item/completed thread id')
      if (this.threadId !== undefined && threadId !== this.threadId) return
      const turnId = identifier(params.turnId, 'item/completed turn id')
      const item = object(params.item, 'item/completed item')
      if (item.type !== 'webSearch') return
      this.itemsByTurn.set(turnId, [...this.itemsByTurn.get(turnId) ?? [], item])
      return
    }
    if (method !== 'turn/completed') return
    const threadId = identifier(params.threadId, 'turn/completed thread id')
    if (this.threadId !== undefined && threadId !== this.threadId) return
    const turn = object(params.turn, 'turn/completed turn')
    const turnId = identifier(turn.id, 'turn/completed turn id')
    this.completedByTurn.set(turnId, turn)
    if (turnId === this.turnId) this.turnCompleted?.resolve(turn)
  }
}
