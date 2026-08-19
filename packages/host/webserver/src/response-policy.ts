/**
 * The carrier's per-response encoding and caching policy: one patch over a
 * live node:http ServerResponse that negotiates a content coding for
 * compressible bodies and attaches the Cache-Control the request URL earns.
 * Installed once per request by the WebServer before dispatch, so every named
 * route, the fallback seat, and the carrier's own error answers pass through
 * it without knowing it exists.
 * @module @deepseek-ai/dsh-host-webserver/response-policy
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Transform } from 'node:stream'
import { cacheControlFor, type CachePolicy } from './response-cache.ts'
import {
  createCompressor,
  isCompressibleMediaType,
  selectResponseEncoding,
  type CompressorLevels,
  type ResponseEncoding,
} from './response-encoding.ts'

/** The deployment-settable half of the compression policy. */
export interface CompressionPolicy extends CompressorLevels {
  /** Whether the carrier negotiates a coding at all. */
  enabled: boolean
  /** Bodies smaller than this stay uncompressed. */
  minBytes: number
}

/** Everything the response patch needs from configuration. */
export interface ResponsePolicy {
  /** Encoding negotiation knobs. */
  compression: CompressionPolicy
  /** Cache-Control knobs. */
  cache: CachePolicy
}

/** node:http passes (chunk, encoding?, callback?) through every write/end overload. */
type RawWrite = (chunk?: unknown, encoding?: unknown, callback?: unknown) => boolean
type RawEnd = (chunk?: unknown, encoding?: unknown, callback?: unknown) => void
type RawWriteHead = (...args: unknown[]) => void

/** Read one outgoing or incoming header as text, taking the first of a repeated field. */
function headerText(value: number | string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value[0]
  return String(value)
}

/** Add Accept-Encoding to an existing Vary field without duplicating it. */
function varyWithAcceptEncoding(existing: string | undefined): string {
  if (existing === undefined || existing.trim() === '') return 'Accept-Encoding'
  const fields = existing.split(',').map(field => field.trim().toLowerCase())
  if (fields.includes('accept-encoding') || fields.includes('*')) return existing
  return existing + ', Accept-Encoding'
}

/** Materialize one written chunk as bytes; undefined for a bodiless end() call. */
function toBuffer(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return undefined
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
  }
  if (Buffer.isBuffer(chunk)) return chunk
  const view = chunk as Uint8Array
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}

/** Recover the completion callback from either write/end overload position. */
function callbackOf(encoding: unknown, callback: unknown): (() => void) | undefined {
  if (typeof encoding === 'function') return encoding as () => void
  if (typeof callback === 'function') return callback as () => void
  return undefined
}

/** Record the headers of either writeHead form into the pending set, lower-cased. */
function recordHeaders(pending: OutgoingHttpHeaders, provided: unknown): void {
  if (Array.isArray(provided)) {
    // node:http's flat [name, value, name, value, ...] form.
    for (let at = 0; at + 1 < provided.length; at += 2) {
      pending[String(provided[at]).toLowerCase()] = provided[at + 1] as string
    }
    return
  }
  if (typeof provided !== 'object' || provided === null) return
  for (const [key, value] of Object.entries(provided as OutgoingHttpHeaders)) {
    pending[key.toLowerCase()] = value
  }
}

/**
 * Install the encoding and caching policy on one response.
 *
 * The patch defers the real writeHead until it knows whether the body earns a
 * coding, then behaves as one of three answers:
 *
 * - **Passthrough** — the body is not a compression candidate (a HEAD request,
 *   a status without a body, an already-encoded body, a media type not worth
 *   compressing, or a client that offered no coding). Headers commit
 *   immediately and every later write reaches the socket untouched, so an open
 *   SSE channel is never held back.
 * - **Uncompressed under the threshold** — a candidate whose complete body
 *   stayed below `minBytes`. It buffers, then flushes verbatim: below that size a
 *   coding's own framing costs more than it saves.
 * - **Compressed** — a candidate that reached `minBytes`. Headers commit with
 *   Content-Encoding and without Content-Length (chunked framing, since the
 *   encoded length is not known up front) and the rest streams through the
 *   compressor, so a large body is never fully resident.
 *
 * Buffering is bounded by `minBytes`: the moment the body reaches it the patch
 * commits and streams, so a long response holds at most that many bytes.
 *
 * Vary: Accept-Encoding is set on every candidate, including one answered
 * uncompressed, because the same URL answers differently per client and a
 * shared cache keyed without it would hand a brotli body to a client that
 * cannot decode one. Cache-Control is supplied only when the handler set none,
 * so a route that states its own caching keeps it.
 *
 * The first writeHead decides the answer; the carrier's routes call it once.
 *
 * @param req - the request being answered; read for method, URL, and Accept-Encoding.
 * @param res - the response to patch, mutated in place and keeping its identity.
 * @param policy - the deployment's compression and caching configuration.
 * @param onError - receives a compressor failure before the response is destroyed.
 */
export function applyResponsePolicy(
  req: IncomingMessage,
  res: ServerResponse,
  policy: ResponsePolicy,
  onError: (error: Error) => void,
): void {
  const rawWriteHead = res.writeHead.bind(res) as unknown as RawWriteHead
  const rawWrite = res.write.bind(res) as unknown as RawWrite
  const rawEnd = res.end.bind(res) as unknown as RawEnd
  const rawFlushHeaders = res.flushHeaders.bind(res)

  let phase: 'undecided' | 'passthrough' | 'buffering' | 'compressing' | 'ended' = 'undecided'
  let status: number | undefined
  let statusMessage: string | undefined
  let chosen: Exclude<ResponseEncoding, 'identity'> = 'gzip'
  let compressor: Transform | undefined
  const pending: OutgoingHttpHeaders = {}
  const buffered: Buffer[] = []
  let bufferedBytes = 0

  // A handler that never calls writeHead states its status on res.statusCode,
  // which node:http would have read when it wrote the implicit header.
  const statusCode = (): number => status ?? res.statusCode

  const commit = (): void => {
    if (statusMessage === undefined) rawWriteHead(statusCode(), pending)
    else rawWriteHead(statusCode(), statusMessage, pending)
  }

  const decide = (): void => {
    const code = statusCode()
    const headers = { ...res.getHeaders(), ...pending }
    const contentType = headerText(headers['content-type'])
    if (headers['cache-control'] === undefined) {
      /* v8 ignore next -- fallback arm: node:http always sets url on server requests. */
      pending['cache-control'] = cacheControlFor(req.url ?? '/', contentType, policy.cache)
    }
    const candidate = policy.compression.enabled
      && req.method !== 'HEAD'
      && code >= 200 && code < 300 && code !== 204 && code !== 205
      && headers['content-encoding'] === undefined
      && isCompressibleMediaType(contentType)
    if (!candidate) {
      phase = 'passthrough'
      commit()
      return
    }
    pending.vary = varyWithAcceptEncoding(headerText(headers.vary))
    const encoding = selectResponseEncoding(headerText(req.headers['accept-encoding']))
    if (encoding === 'identity') {
      phase = 'passthrough'
      commit()
      return
    }
    chosen = encoding
    phase = 'buffering'
  }

  const startCompressing = (): Transform => {
    delete pending['content-length']
    res.removeHeader('content-length')
    pending['content-encoding'] = chosen
    const stream = createCompressor(chosen, policy.compression)
    compressor = stream
    phase = 'compressing'
    stream.on('data', (chunk: Buffer) => {
      if (!rawWrite(chunk)) stream.pause()
    })
    stream.on('end', () => { rawEnd() })
    /* v8 ignore next 4 -- zlib compressing an in-memory buffer has no reachable
    failure mode; the arm exists so a transform error destroys the response
    instead of reaching the process as an unhandled 'error' event. */
    stream.on('error', (error: Error) => {
      onError(error)
      res.destroy()
    })
    res.on('drain', () => { stream.resume() })
    res.once('close', () => { stream.destroy() })
    commit()
    for (const chunk of buffered) stream.write(chunk)
    buffered.length = 0
    bufferedBytes = 0
    return stream
  }

  const feedCompressor = (
    stream: Transform, body: Buffer | undefined, done: (() => void) | undefined,
  ): boolean => {
    if (body === undefined) {
      if (done !== undefined) queueMicrotask(done)
      return true
    }
    const accepted = done === undefined ? stream.write(body) : stream.write(body, done)
    // Forward the compressor's backpressure as the response's: a producer
    // awaiting 'drain' on the response would otherwise wait on a socket that
    // is not the bottleneck.
    if (!accepted) stream.once('drain', () => { res.emit('drain') })
    return accepted
  }

  const buffer = (body: Buffer | undefined): void => {
    if (body === undefined) return
    buffered.push(body)
    bufferedBytes += body.byteLength
  }

  // node:http answers headersSent from the bytes on the socket, which the patch
  // deliberately withholds while it measures the threshold. The carrier's
  // per-request error containment asks this question to choose between an error
  // status and destroying the socket, so the answer it needs is whether the
  // handler's head is still changeable — which is what phase records.
  Object.defineProperty(res, 'headersSent', {
    configurable: true,
    get: () => phase !== 'undecided',
  })

  res.writeHead = ((...args: unknown[]) => {
    if (phase !== 'undecided') return res
    status = args[0] as number
    if (typeof args[1] === 'string') statusMessage = args[1]
    recordHeaders(pending, typeof args[1] === 'string' ? args[2] : args[1])
    decide()
    return res
  })

  res.write = ((chunk?: unknown, encoding?: unknown, callback?: unknown): boolean => {
    if (phase === 'undecided') decide()
    if (phase === 'passthrough' || phase === 'ended') return rawWrite(chunk, encoding, callback)
    const body = toBuffer(chunk, encoding)
    const done = callbackOf(encoding, callback)
    if (compressor !== undefined) return feedCompressor(compressor, body, done)
    buffer(body)
    if (bufferedBytes >= policy.compression.minBytes) startCompressing()
    if (done !== undefined) queueMicrotask(done)
    return true
  }) as ServerResponse['write']

  res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown): ServerResponse => {
    if (phase === 'undecided') decide()
    if (phase === 'passthrough' || phase === 'ended') {
      rawEnd(chunk, encoding, callback)
      return res
    }
    const body = toBuffer(chunk, encoding)
    const done = callbackOf(encoding, callback)
    if (compressor !== undefined) {
      phase = 'ended'
      if (body === undefined) compressor.end(done)
      else compressor.end(body, done)
      return res
    }
    buffer(body)
    if (bufferedBytes >= policy.compression.minBytes) {
      const stream = startCompressing()
      phase = 'ended'
      if (done === undefined) stream.end()
      else stream.end(done)
      return res
    }
    // Under the threshold the complete body is known, so it goes out verbatim
    // under the headers the handler asked for.
    commit()
    phase = 'ended'
    for (const pendingChunk of buffered) rawWrite(pendingChunk)
    rawEnd(undefined, undefined, done)
    return res
  }) as ServerResponse['end']

  // A handler flushing headers ahead of its body is streaming: it cannot be
  // held back to measure a threshold, so it degrades to passthrough carrying
  // the Cache-Control and Vary the policy already decided.
  res.flushHeaders = (): void => {
    if (phase === 'undecided') decide()
    if (phase === 'buffering') {
      phase = 'passthrough'
      commit()
    }
    rawFlushHeaders()
  }
}
