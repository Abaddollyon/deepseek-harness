/**
 * The Web carrier's per-response content-coding and cache policy.
 *
 * The policy patches one live `node:http` response before route dispatch. It
 * keeps candidate bodies bounded while it decides whether to pass them
 * through unchanged or stream them through a Brotli or gzip transform.
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

/** The deployment-settable content-coding settings. */
export interface CompressionPolicy extends CompressorLevels {
  /** Whether the carrier negotiates and emits a content coding. */
  enabled: boolean
  /** Maximum number of unencoded body bytes retained while deciding. */
  minBytes: number
}

/** The cache and content-coding settings applied to one response. */
export interface ResponsePolicy {
  /** Content-coding settings. */
  compression: CompressionPolicy
  /** Cache-Control settings. */
  cache: CachePolicy
}

/**
 * Injectable operations used by the local response-policy tests.
 *
 * Production uses {@link createCompressor} and `process.nextTick`. The seam
 * is intentionally module-local to the webserver package and is not part of
 * the package barrel or the public webserver service.
 */
export interface ResponsePolicyRuntime {
  /** Create the transform for one negotiated content coding. */
  createCompressor: typeof createCompressor
  /** Schedule one carrier callback. */
  nextTick: (callback: () => void) => void
}

/** Raw `node:http` write overload used after the response is patched. */
type RawWrite = (chunk?: unknown, encoding?: unknown, callback?: unknown) => boolean

/** Raw `node:http` end overload used after the response is patched. */
type RawEnd = (chunk?: unknown, encoding?: unknown, callback?: unknown) => void

/** Raw `node:http` writeHead overload used after the response is patched. */
type RawWriteHead = (...args: unknown[]) => ServerResponse

/** Callback accepted by node streams and response methods. */
type ResponseCallback = (error?: Error | null) => void

/** One body record waiting for the transform or the socket. */
interface PendingWrite {
  /** Body bytes accepted by the carrier. */
  body: Buffer
  /** Completion callback owned by the carrier, if the caller supplied one. */
  callback: GuardedCallback | undefined
}

/** A response callback that ignores every invocation after the first. */
type GuardedCallback = ResponseCallback

/** One listener registration in the carrier-owned drain list. */
interface DrainRegistration {
  /** Original listener supplied by the route. */
  listener: DrainListener
  /** Whether this registration is removed before it runs. */
  once: boolean
}

/** Listener signature accepted by the EventEmitter methods we patch. */
type DrainListener = (...args: unknown[]) => void

/** Response lifecycle phases owned by this module. */
type ResponsePhase = 'undecided' | 'passthrough' | 'buffering' | 'compressing' | 'failed'

/** Read one incoming or outgoing header value as one comparison string. */
function headerText(value: number | string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/** Add Accept-Encoding to Vary without adding a second copy. */
function varyWithAcceptEncoding(existing: string | undefined): string {
  if (existing === undefined || existing.trim() === '') return 'Accept-Encoding'
  const fields = existing.split(',').map(field => field.trim().toLowerCase())
  if (fields.includes('accept-encoding') || fields.includes('*')) return existing
  return `${existing}, Accept-Encoding`
}

/** Materialize one body argument as bytes, or return undefined for no body. */
function toBuffer(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return undefined
  if (typeof chunk === 'string') {
    const textEncoding = typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8'
    return Buffer.from(chunk, textEncoding)
  }
  if (Buffer.isBuffer(chunk)) return chunk
  const view = chunk as Uint8Array
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}

/** Return the callback from any write or end overload slot. */
function callbackOf(chunk: unknown, encoding: unknown, callback: unknown): ResponseCallback | undefined {
  if (typeof chunk === 'function') return chunk as ResponseCallback
  if (typeof encoding === 'function') return encoding as ResponseCallback
  if (typeof callback === 'function') return callback as ResponseCallback
  return undefined
}

/** Return only a string encoding for a raw write or end call. */
function nativeEncoding(encoding: unknown): string | undefined {
  return typeof encoding === 'string' ? encoding : undefined
}

/** Record either supported writeHead header representation without mutation. */
function recordHeaders(pending: OutgoingHttpHeaders, provided: unknown): void {
  if (Array.isArray(provided)) {
    const flat = provided as readonly unknown[]
    for (let at = 0; at + 1 < flat.length; at += 2) {
      const name = String(flat[at]).toLowerCase()
      const value = flat[at + 1]
      const values = Array.isArray(value)
        ? (value as readonly unknown[]).map(item => String(item))
        : [String(value)]
      const previous = pending[name]
      if (previous === undefined) {
        pending[name] = values.length === 1 ? values[0] : values
      } else {
        const existing = Array.isArray(previous) ? previous.map(item => item) : [String(previous)]
        pending[name] = [...existing, ...values]
      }
    }
    return
  }
  if (provided === null || typeof provided !== 'object') return
  for (const [name, value] of Object.entries(provided as OutgoingHttpHeaders)) {
    pending[name.toLowerCase()] = value
  }
}

/** Normalize thrown values before they reach callback and destroy paths. */
function asError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

/** Create a node-style error with the code used by the native response. */
function errorWithCode(message: string, code: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

/**
 * Install the production response policy.
 *
 * The response is mutated in place. Compression failures are reported to
 * `onError`, all outstanding callbacks receive the same error once, and the
 * response is destroyed after the error has been reported.
 * @param req - Request being answered.
 * @param res - Response to patch in place.
 * @param policy - Validated deployment compression and cache settings.
 * @param onError - Receives one compressor or compressor-setup failure.
 * @returns Nothing; later route writes use the patched response methods.
 */
export function applyResponsePolicy(
  req: IncomingMessage,
  res: ServerResponse,
  policy: ResponsePolicy,
  onError: (error: Error) => void,
): void {
  applyResponsePolicyWithRuntime(req, res, policy, onError, {
    createCompressor,
    nextTick: (callback) => { process.nextTick(callback) },
  })
}

/**
 * Install the response policy with deterministic compressor and scheduling
 * operations for tests that must drive transform events explicitly.
 *
 * The carrier callback for `write()` means that the body was accepted by the
 * carrier or transform. The callback passed to `end()` is held until the
 * physical raw response end callback runs. A transform or response failure
 * settles each outstanding callback once and destroys the unfinished response.
 * @param req - Request being answered.
 * @param res - Response to patch in place.
 * @param policy - Compression and cache settings for this response.
 * @param onError - Receives one compressor or compressor-setup failure.
 * @param runtime - Injected transform factory and callback scheduler.
 * @returns Nothing; later route writes use the patched response methods.
 */
export function applyResponsePolicyWithRuntime(
  req: IncomingMessage,
  res: ServerResponse,
  policy: ResponsePolicy,
  onError: (error: Error) => void,
  runtime: ResponsePolicyRuntime,
): void {
  const rawWriteHead = res.writeHead.bind(res) as unknown as RawWriteHead
  const nativeWrite = res.write.bind(res) as unknown as RawWrite
  const nativeEnd = res.end.bind(res) as unknown as RawEnd
  const rawFlushHeaders = res.flushHeaders.bind(res)
  const rawSetHeader = res.setHeader.bind(res)
  const rawRemoveHeader = res.removeHeader.bind(res)
  const rawAppendHeader = res.appendHeader.bind(res)
  const rawDestroy = res.destroy.bind(res)
  const rawOn = res.on.bind(res) as unknown as (event: string, listener: DrainListener) => ServerResponse
  const rawOnce = res.once.bind(res) as unknown as (event: string, listener: DrainListener) => ServerResponse
  const rawAddListener = res.addListener.bind(res) as unknown as (event: string, listener: DrainListener) => ServerResponse
  const rawRemoveListener = res.removeListener.bind(res) as unknown as (event: string, listener: DrainListener) => ServerResponse
  const rawRemoveAllListeners = res.removeAllListeners.bind(res)
  const rawEventNames = res.eventNames.bind(res)
  const rawListenerCount = res.listenerCount.bind(res)
  const rawEmit = res.emit.bind(res) as unknown as (event: string, ...args: unknown[]) => boolean

  const threshold = Number.isFinite(policy.compression.minBytes)
    ? Math.max(0, policy.compression.minBytes)
    : 0
  let phase: ResponsePhase = 'undecided'
  let headersDecided = false
  let headerCommitted = false
  let logicalEnded = false
  let nativeFinished = res.writableEnded
  let nativeWritableEnded = res.writableEnded
  let nativeWritableFinished = res.writableFinished
  let internalSinkDepth = 0
  let sinkEnded = false
  let endSettled = false
  let failureStarted = false
  let failureError: Error | undefined
  let compressorErrorReported = false
  let compressor: Transform | undefined
  let compressorBlocked = false
  let sinkBlocked = false
  let sinkPaused = false
  let drainOwed = false
  let status: number | undefined
  let statusMessage: string | undefined
  let chosen: Exclude<ResponseEncoding, 'identity'> = 'gzip'
  let committing = false
  let bufferedBytes = 0
  let compressorEndRequested = false
  let compressorEndCalled = false
  let compressorEndBody: Buffer | undefined
  let pumpingCompressor = false

  const pendingHeaders: OutgoingHttpHeaders = {}
  const bufferedWrites: PendingWrite[] = []
  const compressorWrites: PendingWrite[] = []
  const endCallbacks: GuardedCallback[] = []
  const pendingCallbacks = new Set<GuardedCallback>()
  const drainListeners: DrainRegistration[] = []

  /** Invoke a user callback at most once and remove it from failure tracking. */
  const guardedCallback = (callback: ResponseCallback | undefined): GuardedCallback | undefined => {
    if (callback === undefined) return undefined
    let called = false
    const guarded: GuardedCallback = (error) => {
      if (called) return
      called = true
      pendingCallbacks.delete(guarded)
      callback(error ?? undefined)
    }
    pendingCallbacks.add(guarded)
    return guarded
  }

  /** Settle callbacks waiting for the physical response end exactly once. */
  const settleEnd = (error?: Error): void => {
    if (endSettled) return
    endSettled = true
    if (error !== undefined && failureError === undefined) failureError = error
    const settledError = error ?? failureError
    for (const callback of endCallbacks.splice(0)) callback(settledError)
  }

  /** Fail the response once and close both sides of an active transform. */
  const fail = (error: Error): void => {
    if (failureStarted) return
    failureStarted = true
    phase = 'failed'
    compressorErrorReported = true
    settleEnd(error)
    bufferedWrites.length = 0
    compressorWrites.length = 0
    bufferedBytes = 0
    drainListeners.length = 0
    for (const callback of [...pendingCallbacks]) callback(error)
    if (compressor !== undefined && !compressor.destroyed) compressor.destroy(error)
    if (!res.destroyed) rawDestroy(error)
  }

  /** Schedule successful carrier acceptance for a body-free write. */
  const settleAccepted = (callback: GuardedCallback | undefined): void => {
    if (callback === undefined) return
    runtime.nextTick(() => { callback() })
  }

  /** Return whether a new public write may be accepted at this instant. */
  const publicWritable = (): boolean => !compressorBlocked && !sinkBlocked

  /** Remove one exact drain registration, preserving duplicate registrations. */
  const removeDrainRegistration = (registration: DrainRegistration): void => {
    const at = drainListeners.indexOf(registration)
    if (at !== -1) drainListeners.splice(at, 1)
  }

  /** Dispatch one owed public drain after both internal blockers clear. */
  const dispatchDrain = (): void => {
    if (!drainOwed || compressorBlocked || sinkBlocked || failureStarted) return
    drainOwed = false
    const registrations = [...drainListeners]
    for (const registration of registrations) {
      if (registration.once) removeDrainRegistration(registration)
      registration.listener.call(res)
    }
  }

  /** Update compressor input backpressure without changing sink state. */
  const markCompressorBlocked = (blocked: boolean): void => {
    compressorBlocked = blocked
    if (blocked) {
      drainOwed = true
      return
    }
    pumpCompressorInput()
    dispatchDrain()
  }

  /** Update sink backpressure and pause/resume the transform readable side. */
  const markSinkBlocked = (blocked: boolean): void => {
    sinkBlocked = blocked
    if (blocked) {
      drainOwed = true
      if (compressor !== undefined && !sinkPaused) {
        compressor.pause()
        sinkPaused = true
      }
      return
    }
    if (compressor !== undefined && sinkPaused) {
      compressor.resume()
      sinkPaused = false
    }
    dispatchDrain()
  }

  /** Wrap a transform or socket callback so its error enters the controller. */
  const completionFor = (
    callback: GuardedCallback | undefined,
    onFailure: (error: Error) => void = fail,
  ): ResponseCallback | undefined => {
    if (callback === undefined) return undefined
    return (error) => {
      if (error !== undefined && error !== null) {
        onFailure(error)
        return
      }
      callback()
    }
  }

  /** Write one accepted record into the compressor and preserve its callback. */
  const writeRecordToCompressor = (stream: Transform, record: PendingWrite): boolean | undefined => {
    const completion = completionFor(record.callback, reportCompressorError)
    try {
      const accepted = completion === undefined
        ? stream.write(record.body)
        : stream.write(record.body, completion)
      if (!accepted) markCompressorBlocked(true)
      return accepted
    } catch (error) {
      reportCompressorError(error)
      return undefined
    }
  }

  /** Pump queued input until the transform asks the carrier to pause. */
  function pumpCompressorInput(): void {
    if (pumpingCompressor || compressor === undefined || failureStarted) return
    pumpingCompressor = true
    try {
      while (compressorWrites.length > 0 && !compressorBlocked) {
        const record = compressorWrites.shift() as PendingWrite
        if (writeRecordToCompressor(compressor, record) === undefined) return
      }
      if (
        compressorWrites.length === 0
        && compressorEndRequested
        && !compressorEndCalled
        && !compressorBlocked
      ) {
        compressorEndCalled = true
        try {
          if (compressorEndBody === undefined) compressor.end()
          else compressor.end(compressorEndBody)
        } catch (error) {
          reportCompressorError(error)
        }
      }
    } finally {
      pumpingCompressor = false
    }
  }

  /** Queue input for the compressor and immediately pump when it is writable. */
  const enqueueCompressorWrite = (record: PendingWrite): void => {
    compressorWrites.push(record)
    pumpCompressorInput()
  }

  /** Request transform termination after every queued input record is accepted. */
  const requestCompressorEnd = (body?: Buffer): void => {
    compressorEndRequested = true
    compressorEndBody = body !== undefined && body.byteLength > 0 ? body : undefined
    pumpCompressorInput()
  }

  /** Write one record to the raw socket and route callback errors to failure. */
  const writeRecordToSink = (record: PendingWrite): boolean => {
    const completion = completionFor(record.callback)
    return sinkWrite(record.body, undefined, completion)
  }

  /** Write a body to the raw response while hiding policy-internal writes. */
  function sinkWrite(chunk?: unknown, encoding?: unknown, callback?: unknown): boolean {
    internalSinkDepth += 1
    try {
      const accepted = nativeWrite(chunk, encoding, callback)
      if (!accepted) markSinkBlocked(true)
      return publicWritable()
    } catch (error) {
      fail(asError(error))
      return false
    } finally {
      internalSinkDepth -= 1
    }
  }

  /** End the raw response once, settling end callbacks at its physical callback. */
  function sinkEnd(chunk?: unknown, encoding?: unknown): void {
    if (sinkEnded || failureStarted) return
    sinkEnded = true
    internalSinkDepth += 1
    try {
      nativeWritableEnded = true
      nativeEnd(chunk, encoding, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          fail(error)
          return
        }
        settleEnd()
      })
    } catch (error) {
      fail(asError(error))
    } finally {
      internalSinkDepth -= 1
    }
  }

  /** Flush body records to the socket when threshold compression is abandoned. */
  const flushBufferedToSink = (): void => {
    const records = bufferedWrites.splice(0)
    bufferedBytes = 0
    for (const record of records) {
      if (failureStarted) return
      writeRecordToSink(record)
    }
  }

  /** Return the status a native implicit header would use. */
  const statusCode = (): number => status ?? res.statusCode

  /** Commit the selected headers once, preserving the handler's status message. */
  const commit = (): void => {
    committing = true
    try {
      if (statusMessage === undefined) rawWriteHead(statusCode(), pendingHeaders)
      else rawWriteHead(statusCode(), statusMessage, pendingHeaders)
      headerCommitted = true
    } finally {
      committing = false
    }
  }

  /** Decide candidacy and cache headers from the response as it exists now. */
  const decide = (): void => {
    headersDecided = true
    const headers = { ...res.getHeaders(), ...pendingHeaders }
    const contentType = headerText(headers['content-type'])
    if (headers['cache-control'] === undefined) {
      pendingHeaders['cache-control'] = statusCode() >= 200 && statusCode() < 300
        ? cacheControlFor(req.url ?? '/', contentType, policy.cache)
        : 'no-cache'
    }
    const cacheControl = String(headerText(pendingHeaders['cache-control'] ?? headers['cache-control']))
    const noTransform = cacheControl.split(',')
      .some(directive => /^\s*no-transform(?:\s*=|\s*$)/i.test(directive))
    const candidate = policy.compression.enabled
      && req.method !== 'HEAD'
      && statusCode() >= 200
      && statusCode() < 300
      && ![204, 205, 206].includes(statusCode())
      && req.headers.range === undefined
      && headers['content-range'] === undefined
      && !noTransform
      && headers['content-encoding'] === undefined
      && isCompressibleMediaType(contentType)
    if (!candidate) {
      phase = 'passthrough'
      commit()
      return
    }
    pendingHeaders.vary = varyWithAcceptEncoding(headerText(headers.vary))
    const encoding = selectResponseEncoding(headerText(req.headers['accept-encoding']))
    if (encoding === 'identity') {
      phase = 'passthrough'
      commit()
      return
    }
    chosen = encoding
    phase = 'buffering'
  }

  /** Report one compressor failure and route it through the common teardown. */
  const reportCompressorError = (error: unknown): void => {
    if (compressorErrorReported) return
    compressorErrorReported = true
    const normalized = asError(error)
    try {
      onError(normalized)
    } finally {
      fail(normalized)
    }
  }

  /** Start one compressor, commit encoded headers, and flush retained input. */
  const startCompressor = (): Transform | undefined => {
    try {
      delete pendingHeaders['content-length']
      rawRemoveHeader('content-length')
      pendingHeaders['content-encoding'] = chosen
      const stream = runtime.createCompressor(chosen, policy.compression)
      compressor = stream
      phase = 'compressing'
      stream.on('data', (chunk: Buffer) => {
        sinkWrite(chunk)
      })
      stream.on('drain', () => {
        markCompressorBlocked(false)
      })
      stream.on('end', () => {
        sinkEnd()
      })
      stream.on('error', (error) => {
        reportCompressorError(error)
      })
      commit()
      for (const record of bufferedWrites.splice(0)) compressorWrites.push(record)
      bufferedBytes = 0
      pumpCompressorInput()
      return stream
    } catch (error) {
      reportCompressorError(error)
      return undefined
    }
  }

  /** Reject a body-bearing operation after logical end without destroying twice. */
  const rejectLateWrite = (callback: GuardedCallback | undefined): void => {
    const error = writeAfterEndError()
    if (callback !== undefined) runtime.nextTick(() => { callback(error) })
    runtime.nextTick(() => {
      if (!res.destroyed) rawEmit('error', error)
    })
  }

  /** Create the native error used when a route changes committed headers. */
  const headersSentError = (operation: string): Error => (
    errorWithCode(`Cannot ${operation} headers after they are sent to the client`, 'ERR_HTTP_HEADERS_SENT')
  )

  /** Create the native error used when a route writes after end. */
  const writeAfterEndError = (): Error => errorWithCode('write after end', 'ERR_STREAM_WRITE_AFTER_END')

  /**
   * Expose logical lifecycle state while raw operations run behind the patch.
   * `writableFinished` is set only by the physical finish event; `finished` and
   * `writableEnded` become true when the route has requested logical end.
   */
  Object.defineProperty(res, 'finished', {
    configurable: true,
    get: () => internalSinkDepth > 0 ? nativeFinished : logicalEnded || nativeFinished,
    set: (value: boolean) => {
      nativeFinished = value
    },
  })
  Object.defineProperty(res, 'writableEnded', {
    configurable: true,
    get: () => logicalEnded || nativeWritableEnded,
  })
  Object.defineProperty(res, 'writableFinished', {
    configurable: true,
    get: () => nativeWritableFinished,
  })
  Object.defineProperty(res, 'headersSent', {
    configurable: true,
    get: () => headersDecided || headerCommitted,
  })

  const rawFinishListener = (): void => {
    nativeWritableFinished = true
  }
  const rawCloseListener = (): void => {
    if (!endSettled && !nativeWritableFinished && !failureStarted) {
      fail(errorWithCode('Response closed before completion', 'ECANCELED'))
    }
  }
  const rawDrainListener = (): void => {
    markSinkBlocked(false)
  }
  rawOn('finish', rawFinishListener)
  rawOn('close', rawCloseListener)
  rawOn('drain', rawDrainListener)

  /** Reinstall lifecycle listeners after a caller clears raw listeners. */
  const restoreInternalListeners = (event?: string): void => {
    if (event === undefined || event === 'finish') rawOn('finish', rawFinishListener)
    if (event === undefined || event === 'close') rawOn('close', rawCloseListener)
    if (event === undefined || event === 'drain') rawOn('drain', rawDrainListener)
  }

  /** Add a carrier-owned drain registration, retaining duplicate listeners. */
  const addDrainListener = (listener: DrainListener, once: boolean): void => {
    drainListeners.push({ listener, once })
  }

  /** Remove the most recently registered matching drain listener. */
  const removeDrainListener = (listener: DrainListener): void => {
    for (let at = drainListeners.length - 1; at >= 0; at -= 1) {
      if (drainListeners[at]?.listener === listener) {
        drainListeners.splice(at, 1)
        return
      }
    }
  }

  res.on = ((event: string, listener: DrainListener) => {
    if (event === 'drain') addDrainListener(listener, false)
    else rawOn(event, listener)
    return res
  }) as unknown as ServerResponse['on']
  res.addListener = ((event: string, listener: DrainListener) => {
    if (event === 'drain') addDrainListener(listener, false)
    else rawAddListener(event, listener)
    return res
  }) as unknown as ServerResponse['addListener']
  res.once = ((event: string, listener: DrainListener) => {
    if (event === 'drain') addDrainListener(listener, true)
    else rawOnce(event, listener)
    return res
  }) as unknown as ServerResponse['once']
  res.removeListener = ((event: string, listener: DrainListener) => {
    if (event === 'drain') removeDrainListener(listener)
    else rawRemoveListener(event, listener)
    return res
  }) as unknown as ServerResponse['removeListener']
  res.off = ((event: string, listener: DrainListener) => {
    if (event === 'drain') removeDrainListener(listener)
    else rawRemoveListener(event, listener)
    return res
  }) as ServerResponse['off']
  res.removeAllListeners = ((event?: string) => {
    if (event === undefined || event === 'drain') drainListeners.length = 0
    if (event === undefined) {
      rawRemoveAllListeners()
      restoreInternalListeners()
    } else if (event !== 'drain') {
      rawRemoveAllListeners(event)
      restoreInternalListeners(event)
    }
    return res
  })
  res.eventNames = (() => rawEventNames())
  res.listenerCount = ((event: string | symbol) => {
    if (event === 'drain') return drainListeners.length
    return rawListenerCount(event)
  })

  res.setHeader = ((name: string, value: unknown) => {
    if (headersDecided && !committing) throw headersSentError('set')
    rawSetHeader(name, value as string | number | readonly string[])
    return res
  })
  res.removeHeader = ((name: string) => {
    if (headersDecided && !committing) throw headersSentError('remove')
    rawRemoveHeader(name)
  })
  res.appendHeader = ((name: string, value: string | number | readonly string[]) => {
    if (headersDecided && !committing) throw headersSentError('append')
    rawAppendHeader(name, typeof value === 'number' ? String(value) : value)
    return res
  })
  res.writeHead = ((...args: unknown[]): ServerResponse => {
    if (headersDecided) throw headersSentError('write')
    status = args[0] as number
    res.statusCode = status
    if (typeof args[1] === 'string') {
      statusMessage = args[1]
      res.statusMessage = statusMessage
      recordHeaders(pendingHeaders, args[2])
    } else {
      recordHeaders(pendingHeaders, args[1])
    }
    decide()
    return res
  })

  res.write = ((chunk?: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const done = guardedCallback(callbackOf(chunk, encoding, callback))
    const bodyChunk = typeof chunk === 'function' ? undefined : chunk
    if (logicalEnded) {
      rejectLateWrite(done)
      return false
    }
    if (failureStarted) {
      if (done !== undefined) runtime.nextTick(() => { done(failureError) })
      return false
    }
    if (phase === 'undecided') decide()
    if (phase === 'passthrough') {
      return sinkWrite(bodyChunk, nativeEncoding(encoding), completionFor(done))
    }
    const body = toBuffer(chunk, encoding)
    if (body === undefined || body.byteLength === 0) {
      settleAccepted(done)
      return publicWritable()
    }
    if (phase === 'compressing') {
      enqueueCompressorWrite({ body, callback: done })
      return publicWritable()
    }
    const remaining = Math.max(0, threshold - bufferedBytes)
    if (body.byteLength < remaining) {
      bufferedWrites.push({ body, callback: done })
      bufferedBytes += body.byteLength
      return publicWritable()
    }
    const prefix = body.subarray(0, remaining)
    const suffix = body.subarray(remaining)
    if (prefix.byteLength > 0) {
      bufferedWrites.push({
        body: prefix,
        callback: suffix.byteLength === 0 ? done : undefined,
      })
      bufferedBytes += prefix.byteLength
    }
    const stream = startCompressor()
    if (stream === undefined) return false
    if (suffix.byteLength > 0) enqueueCompressorWrite({ body: suffix, callback: done })
    return publicWritable()
  }) as ServerResponse['write']

  res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown): ServerResponse => {
    const done = guardedCallback(callbackOf(chunk, encoding, callback))
    const bodyChunk = typeof chunk === 'function' ? undefined : chunk
    if (logicalEnded) {
      const body = toBuffer(bodyChunk, encoding)
      if (body !== undefined && body.byteLength > 0) {
        rejectLateWrite(done)
      } else if (done !== undefined) {
        if (endSettled) runtime.nextTick(() => { done(failureError) })
        else endCallbacks.push(done)
      }
      return res
    }
    logicalEnded = true
    if (failureStarted) {
      if (done !== undefined) runtime.nextTick(() => { done(failureError) })
      return res
    }
    if (phase === 'undecided') decide()
    if (phase === 'passthrough') {
      if (done !== undefined) endCallbacks.push(done)
      sinkEnd(bodyChunk, nativeEncoding(encoding))
      return res
    }
    const body = toBuffer(bodyChunk, encoding)
    if (phase === 'compressing') {
      if (done !== undefined) endCallbacks.push(done)
      requestCompressorEnd(body)
      return res
    }
    const remaining = Math.max(0, threshold - bufferedBytes)
    if (body === undefined || body.byteLength < remaining) {
      if (body !== undefined && body.byteLength > 0) {
        bufferedWrites.push({ body, callback: undefined })
        bufferedBytes += body.byteLength
      }
      if (done !== undefined) endCallbacks.push(done)
      phase = 'passthrough'
      commit()
      flushBufferedToSink()
      sinkEnd()
      return res
    }
    const prefix = body.subarray(0, remaining)
    const suffix = body.subarray(remaining)
    if (prefix.byteLength > 0) {
      bufferedWrites.push({ body: prefix, callback: undefined })
      bufferedBytes += prefix.byteLength
    }
    if (done !== undefined) endCallbacks.push(done)
    const stream = startCompressor()
    if (stream === undefined) return res
    requestCompressorEnd(suffix)
    return res
  }) as ServerResponse['end']

  res.flushHeaders = (() => {
    if (phase === 'undecided') decide()
    if (phase === 'buffering') {
      phase = 'passthrough'
      commit()
      flushBufferedToSink()
    }
    rawFlushHeaders()
  })
}
