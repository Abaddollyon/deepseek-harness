/**
 * Newline-delimited JSON-RPC 2.0 over byte streams. Frames with `id` and
 * `method` are requests, `id` alone is a response, and `method` alone is a
 * notification. Malformed lines are ignored; handler failures become error frames.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/transport
 */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

type JsonRpcId = string | number
type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>
type NotificationHandler = (method: string, params: Record<string, unknown>) => void

/** A JSON-RPC error response, preserving the wire `code` and optional `data`. */
export class JsonRpcResponseError extends Error {
  /**
   * @param code - the wire error code, or `undefined` when the peer sent none.
   * @param message - the wire error message.
   * @param data - the optional structured error payload, verbatim.
   */
  constructor(readonly code: number | undefined, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'JsonRpcResponseError'
  }
}

/**
 * Outbound request and notification surface used by the runtime server and
 * SDK clients.
 */
export interface JsonRpcTransportPeer {
  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @returns the result; rejects with {@link JsonRpcResponseError} on an error
   * response, and with a plain `Error` on a write failure or closure.
   */
  request(method: string, params: object): Promise<unknown>
  /**
   * Send a notification; omitted params produce no `params` member.
   * @param method - the JSON-RPC method name.
   * @param params - the optional notification parameters object.
   */
  notify(method: string, params?: object): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Line-delimited endpoint over caller-owned streams. {@link start} attaches
 * input listeners; {@link close} detaches them and rejects pending requests
 * without destroying the streams. An output error is terminal for this
 * transport, and the output error listener remains attached until every write
 * already handed to the caller-owned stream has settled. Missing request
 * handlers return `-32601`; handler failures return `-32603`. Notifications
 * without a handler are dropped.
 */
export class JsonRpcLineTransport implements JsonRpcTransportPeer {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private started = false
  private requestHandler: RequestHandler | undefined
  private notificationHandler: NotificationHandler | undefined
  private malformedHandler: ((line: string) => void) | undefined
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private inputError: Error | undefined
  private terminalError: Error | undefined
  private pendingWrites = 0
  private outputErrorListenerAttached = false
  private outputListenerReleaseScheduled = false
  private readonly onOutputError = (error: Error): void => {
    // Let more specific stream owners observe the same error first (for
    // example, a provider wire that adds protocol context), then settle the
    // generic request waiters before the next event-loop turn.
    this.recordTerminal(error, true)
  }

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    // Writable errors are asynchronous and can occur after write() returned;
    // keep them from becoming unhandled EventEmitter errors and settle every
    // request that can no longer receive a response.
    // A few embedders provide a write-only test double; real Node Writable
    // streams always expose EventEmitter's `on`/`off` methods.
    if (typeof this.output.on === 'function') {
      this.output.on('error', this.onOutputError)
      this.outputErrorListenerAttached = true
    }
  }

  /** Attach the input listeners and begin reading frames. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.input.on('data', this.onData)
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
  }

  /**
   * Detach input listeners and reject pending requests. A queued output write
   * keeps its error listener until its callback settles; the caller-owned
   * streams are never destroyed. Safe before {@link start}.
   */
  close(): void {
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.recordTerminal(new Error('JSON-RPC transport closed'))
    this.scheduleOutputListenerRelease()
  }

  /**
   * Install the request handler, replacing any prior handler.
   * @param handler - resolves to the response `result`; a rejection becomes a
   * `-32603` error response carrying the message.
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /**
   * Install the notification handler, replacing any prior handler.
   * @param handler - invoked per notification with the method and normalized
   * params object.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  /**
   * Install a callback for malformed peer frames.
   * @param handler - Observer receiving the original malformed line.
   */
  onMalformed(handler: (line: string) => void): void {
    this.malformedHandler = handler
  }

  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @param signal - optional abandonment signal: aborting removes the pending
   * entry (no state is retained for a response that may never come) and
   * rejects with the signal's reason.
   * @returns the result; rejects per {@link JsonRpcTransportPeer.request}.
   */
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    if (this.terminalError !== undefined) return Promise.reject(this.terminalError)
    if (this.inputError !== undefined) return Promise.reject(this.inputError)
    const id = `req_${randomUUID().replaceAll('-', '')}`
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      let detach = (): void => {}
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError(signal.reason))
          return
        }
        const onAbort = (): void => {
          this.pending.delete(id)
          reject(abortError(signal.reason))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => { signal.removeEventListener('abort', onAbort) }
      }
      this.pending.set(id, {
        resolve: (value) => {
          detach()
          resolve(value)
        },
        reject: (error) => {
          detach()
          reject(error)
        },
      })
      try {
        this.write(message)
      } catch (error) {
        this.pending.delete(id)
        detach()
        const failure = this.terminalError
          ?? (this.inputError !== undefined && error === this.inputError
            ? this.inputError
            : this.recordTerminal(error))
        reject(failure)
      }
    })
  }

  notify(method: string, params?: object): void {
    if (this.terminalError !== undefined || this.inputError !== undefined) return
    try {
      this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
    } catch {
      // The write path records the terminal error and fails request waiters;
      // notifications have no caller-owned promise to reject.
    }
  }

  /**
   * Wait for prior frame write callbacks. The empty barrier emits no bytes.
   * @returns a promise that settles with the output write callback.
   */
  flush(): Promise<void> {
    if (this.terminalError !== undefined) return Promise.reject(this.terminalError)
    if (this.inputError !== undefined) return Promise.reject(this.inputError)
    return new Promise<void>((resolve, reject) => {
      try {
        this.writeRaw('', (error) => {
          if (error !== undefined) reject(error)
          else resolve()
        })
      } catch (error) {
        reject(this.recordTerminal(error))
      }
    })
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    this.drainLines()
  }

  private drainLines(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      void this.handleLine(line).catch((error: unknown) => {
        this.recordTerminal(error)
      })
    }
  }

  private readonly onInputError = (error: Error): void => {
    this.recordInputError(error)
  }

  private readonly onInputEnd = (): void => {
    this.buffer += this.decoder.end()
    this.drainLines()
    this.recordInputError(new Error('JSON-RPC input closed'))
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.malformedHandler?.(line)
      return
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.malformedHandler?.(line)
      return
    }
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      await this.handleIncomingRequest(id, method, objectParams(frame.params))
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      if (!this.pending.has(id) && this.malformedHandler !== undefined) {
        this.malformedHandler(line)
        return
      }
      this.handleIncomingResponse(id, frame)
      return
    }
    if (typeof method === 'string') {
      this.notificationHandler?.(method, objectParams(frame.params))
      return
    }
    this.malformedHandler?.(line)
  }

  private async handleIncomingRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.requestHandler
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`)
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (this.terminalError === undefined) {
        this.writeError(id, -32603, error instanceof Error ? error.message : String(error))
      }
    }
  }

  private handleIncomingResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as Record<string, unknown>
      pending.reject(new JsonRpcResponseError(
        typeof error.code === 'number' ? error.code : undefined,
        typeof error.message === 'string' ? error.message : 'JSON-RPC error',
        error.data,
      ))
      return
    }
    pending.resolve(frame.result)
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.tryWrite({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private tryWrite(message: Record<string, unknown>): void {
    if (this.terminalError !== undefined) return
    try {
      this.write(message)
    } catch {
      // A response has no caller-owned promise to reject. The write path has
      // already recorded the terminal failure and all pending requests.
    }
  }

  private write(message: Record<string, unknown>, onDone?: (error?: Error) => void): void {
    this.writeRaw(`${JSON.stringify(message)}\n`, onDone)
  }

  private writeRaw(payload: string, onDone?: (error?: Error) => void): void {
    if (this.terminalError !== undefined) throw this.terminalError
    this.pendingWrites += 1
    let settled = false
    const done = (error?: Error | null): void => {
      if (settled) return
      settled = true
      this.pendingWrites -= 1
      const failure = error === undefined || error === null ? undefined : this.recordTerminal(error)
      try {
        onDone?.(failure)
      } finally {
        this.scheduleOutputListenerRelease()
      }
    }
    try {
      this.output.write(payload, done)
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private recordTerminal(error: unknown, deferPending = false): Error {
    const failure = error instanceof Error ? error : new Error(String(error))
    const terminal = this.terminalError ?? failure
    this.terminalError = terminal
    if (deferPending) queueMicrotask(() => { this.failPending(terminal) })
    else this.failPending(terminal)
    this.scheduleOutputListenerRelease()
    return terminal
  }

  private recordInputError(error: unknown): Error {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.inputError ??= failure
    this.failPending(this.inputError)
    return this.inputError
  }

  private scheduleOutputListenerRelease(): void {
    if (!this.outputErrorListenerAttached || this.terminalError === undefined || this.pendingWrites > 0
      || this.outputListenerReleaseScheduled) return
    this.outputListenerReleaseScheduled = true
    setImmediate(() => {
      this.outputListenerReleaseScheduled = false
      this.detachOutputErrorListener()
    })
  }

  private detachOutputErrorListener(): void {
    if (typeof this.output.off === 'function') {
      this.output.off('error', this.onOutputError)
      this.outputErrorListenerAttached = false
      return
    }
    if (typeof this.output.removeListener === 'function') {
      this.output.removeListener('error', this.onOutputError)
      this.outputErrorListenerAttached = false
    }
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}

/** Normalize JSON-RPC `params` to a plain object (arrays and scalars collapse to `{}`). */
function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
}

/** Normalize an abort reason into the rejection Error (a non-Error reason is stringified). */
function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(`JSON-RPC request aborted: ${String(reason)}`)
}
