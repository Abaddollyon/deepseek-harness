/**
 * `IncomingMessage`/`ServerResponse` synthesis for tunnel requests. The app's
 * `node:http` proxy reports a successful bind and captures the webserver's
 * request listener; the tunnel feeds that listener these pairs, so the real
 * route table, its trust fences, and every handler run unchanged.
 *
 * Headers and lifecycle support the Web carrier's response policy; event
 * semantics come from readable-stream. The sink accepts writes synchronously
 * without socket backpressure. Successful callbacks run before finish/close;
 * cancellation closes once and prevents later writes from emitting frames.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/transport/synthetic-http
 */
import { Buffer } from 'buffer'
import { Stream } from 'readable-stream'
import type { TunnelRequestFrame } from './frames.ts'

type HeaderValue = string | number | readonly string[]
type ResponseCallback = (error?: Error) => void

/** Where a synthesized response writes to. */
export interface ResponseSink {
  /** Head of a streaming response. */
  head(status: number, headers: Record<string, string>): void
  /** One body chunk after {@link ResponseSink.head}. */
  chunk(bytes: Uint8Array): void
  /** Completion; the payload is present only for unary answers. */
  end(payload?: { status: number; headers: Record<string, string>; body?: Uint8Array | undefined }): void
  /** Failure of the exchange. */
  fail(message: string): void
}

/** Request listener shape the app's `createServer` captured. */
export type RequestListener = (req: unknown, res: unknown) => void

/** The pair a route handler consumes, plus abort control for the tunnel. */
export interface SyntheticExchange {
  readonly req: unknown
  readonly res: unknown
  /** Whether the page abandoned the request before it finished. */
  readonly aborted: boolean
  /** Mark the page as gone: emits `close` and stops further frames. */
  abort(): void
}

/**
 * Build the request/response pair for one tunnel request.
 *
 * `res.end()` is the settle point: the captured listener returns void, so the
 * response object itself reports completion. Accepted writes return true;
 * writes after end or cancellation return false without emitting frames.
 * @param frame - Validated request frame.
 * @param sink - Frame emitter for the response.
 * @returns The pair handed to the captured request listener.
 */
export function createSyntheticExchange(frame: TunnelRequestFrame, sink: ResponseSink): SyntheticExchange {
  const headers = new Map<string, HeaderValue>()
  let streaming = false
  let ended = false
  let finished = false
  let aborted = false
  let failure: Error | undefined

  const wireHeaders = (): Record<string, string> => Object.fromEntries(
    [...headers].map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]),
  )
  const bytes = (chunk: string | Uint8Array, encoding?: BufferEncoding): Uint8Array => (
    typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
  )
  const accepted = (callback: ResponseCallback | undefined): void => {
    if (callback !== undefined) queueMicrotask(() => { callback(failure) })
  }

  const req = {
    url: frame.url,
    method: frame.method,
    headers: frame.headers,
    destroy: (): void => { abort() },
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      if (frame.body === undefined) return
      if (frame.body instanceof Blob) {
        for await (const chunk of frame.body.stream()) {
          if (aborted) return
          if (chunk.byteLength > 0) yield chunk
        }
        return
      }
      if (frame.body instanceof ReadableStream) {
        for await (const chunk of frame.body) {
          if (aborted) return
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError('webworker tunnel: request stream produced a non-Uint8Array chunk')
          }
          if (chunk.byteLength > 0) yield chunk
        }
        return
      }
      if (aborted || frame.body.byteLength === 0) return
      yield new Uint8Array(frame.body)
    },
  }

  const res = Object.assign(new Stream(), {
    statusCode: 200,
    statusMessage: 'OK',
    getHeader: (name: string): HeaderValue | undefined => headers.get(name.toLowerCase()),
    getHeaders: (): Record<string, HeaderValue> => Object.fromEntries(headers),
    setHeader: (name: string, value: HeaderValue): unknown => {
      headers.set(name.toLowerCase(), value)
      return res
    },
    removeHeader: (name: string): void => { headers.delete(name.toLowerCase()) },
    appendHeader: (name: string, value: HeaderValue): unknown => {
      const key = name.toLowerCase()
      const previous = headers.get(key)
      headers.set(key, previous === undefined ? value : [
        ...typeof previous === 'object' ? previous : [String(previous)],
        ...typeof value === 'object' ? value : [String(value)],
      ])
      return res
    },
    writeHead: (
      nextStatus: number, messageOrHeaders?: string | Record<string, HeaderValue>, provided?: Record<string, HeaderValue>,
    ): unknown => {
      res.statusCode = nextStatus
      if (typeof messageOrHeaders === 'string') res.statusMessage = messageOrHeaders
      const nextHeaders = typeof messageOrHeaders === 'string' ? provided : messageOrHeaders
      if (nextHeaders !== undefined) {
        for (const [key, value] of Object.entries(nextHeaders)) headers.set(key.toLowerCase(), value)
      }
      return res
    },
    flushHeaders: (): void => {
      if (streaming || ended || failure !== undefined) return
      streaming = true
      sink.head(res.statusCode, wireHeaders())
    },
    write: (chunk: string | Uint8Array, encoding?: BufferEncoding | ResponseCallback, callback?: ResponseCallback): boolean => {
      accepted(typeof encoding === 'function' ? encoding : callback)
      if (ended || failure !== undefined) return false
      if (!streaming) {
        streaming = true
        sink.head(res.statusCode, wireHeaders())
      }
      sink.chunk(bytes(chunk, typeof encoding === 'string' ? encoding : undefined))
      return true
    },
    end: (
      body?: string | Uint8Array | ResponseCallback, encoding?: BufferEncoding | ResponseCallback, callback?: ResponseCallback,
    ): unknown => {
      const done = typeof body === 'function' ? body : typeof encoding === 'function' ? encoding : callback
      if (ended || failure !== undefined) {
        accepted(done)
        return res
      }
      ended = true
      const payload = body === undefined || typeof body === 'function'
        ? undefined
        : bytes(body, typeof encoding === 'string' ? encoding : undefined)
      if (streaming) {
        if (payload !== undefined) sink.chunk(payload)
        sink.end()
      } else {
        sink.end({ status: res.statusCode, headers: wireHeaders(), body: payload })
      }
      queueMicrotask(() => {
        done?.(failure)
        if (failure !== undefined) return
        finished = true
        res.emit('finish')
        res.emit('close')
      })
      return res
    },
    destroy: (error?: Error): unknown => {
      if (finished || failure !== undefined) return res
      failure = error ?? new Error(`response destroyed for ${frame.method} ${frame.url}`)
      if (!ended) sink.fail(failure.message)
      res.emit('close')
      return res
    },
  })
  Object.defineProperty(res, 'headersSent', { configurable: true, get: () => streaming })
  Object.defineProperty(res, 'writableEnded', { configurable: true, get: () => ended })
  Object.defineProperty(res, 'writableFinished', { configurable: true, get: () => finished })
  Object.defineProperty(res, 'destroyed', { get: () => failure !== undefined })

  const abort = (): void => {
    if (finished || failure !== undefined) return
    aborted = true
    failure = new Error(`request aborted for ${frame.method} ${frame.url}`)
    res.emit('aborted')
    res.emit('close')
  }
  return {
    req,
    res,
    get aborted(): boolean {
      return aborted
    },
    abort,
  }
}
