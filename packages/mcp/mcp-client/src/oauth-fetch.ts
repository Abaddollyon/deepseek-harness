/**
 * The bounded fetch every OAuth protocol request runs through: discovery,
 * registration, token, and revocation. It refuses origins outside the spec
 * allowlist, non-HTTPS targets, and targets carrying userinfo or a fragment;
 * never follows redirects and refuses a 3xx or a response from another
 * origin even when the underlying fetch would have; sends no ambient
 * credentials; and holds one wall-clock bound and one byte bound over the
 * whole response including its body — a missing or understated
 * Content-Length does not widen either bound. Its promises settle within the
 * bound even when the underlying fetch ignores its abort signal: a Response
 * that arrives after the bound has its body closed on arrival.
 *
 * @module
 */

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpOAuthError } from './oauth-error.ts'

/** Bounds and allowlist for one operation's protocol requests. */
export interface BoundedFetchPolicy {
  /** Origins a request may target; anything else fails before any network access. */
  readonly allowedOrigins: ReadonlySet<string>
  /** Wall-clock bound per request from send to end of body, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Body byte bound per response. */
  readonly responseByteLimit: number
}

/** Statuses whose response carries no body by definition; `new Response(body)` refuses one. */
const BODYLESS_STATUSES = new Set([101, 204, 205, 304])

function noop(): void {}

/**
 * Resolve a fetch target to a fresh URL.
 * @param input - fetch target.
 * @returns the target URL.
 */
export function requestUrl(input: string | URL): URL {
  return new URL(input)
}

/** Close a body nobody will read; a cancel that never settles is not waited for. */
function discard(body: ReadableStream<Uint8Array> | null, reason: unknown): void {
  body?.cancel(reason).catch(noop)
}

/**
 * Wrap an external fetch with the operation's bounds. Every failure surfaces
 * as an {@link McpOAuthError} — never a `TypeError`, which the SDK's discovery
 * treats as a CORS miss and silently falls back from.
 * @param external - the fetch to send through, production or test fake.
 * @param policy - allowlist and bounds.
 * @param signal - the owning operation's signal; abort cancels the request and body.
 * @param onFailure - receives each failure so the owner can report the real cause when the SDK swallows it.
 * @returns a fetch the SDK helpers can use.
 */
export function createBoundedFetch(
  external: FetchLike,
  policy: BoundedFetchPolicy,
  signal: AbortSignal,
  onFailure: (error: McpOAuthError) => void,
): FetchLike {
  const fail = (error: McpOAuthError): McpOAuthError => {
    onFailure(error)
    return error
  }
  return async (input, init) => {
    const url = requestUrl(input)
    if (url.protocol !== 'https:' || !policy.allowedOrigins.has(url.origin)) {
      throw fail(new McpOAuthError(`OAuth protocol request targets ${url.origin}, outside the allowed origins`, 'ENDPOINT_NOT_ALLOWED'))
    }
    if (url.username !== '' || url.password !== '' || url.hash !== '') {
      throw fail(new McpOAuthError('OAuth protocol request target carries userinfo or a fragment', 'ENDPOINT_NOT_ALLOWED'))
    }
    if (signal.aborted) throw fail(asEngineError(signal.reason))
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new McpOAuthError('OAuth protocol request exceeded its time bound', 'NETWORK'))
    }, policy.requestTimeoutMs)
    const forward = (): void => { controller.abort(signal.reason) }
    signal.addEventListener('abort', forward, { once: true })
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    }
    /** The failure to surface once the request is known to have died, preferring the abort reason we set. */
    const failure = (error: unknown): McpOAuthError => {
      release()
      return fail(asEngineError(controller.signal.aborted ? controller.signal.reason : error))
    }
    // Rejects when this request is aborted; listened to before anything can abort it.
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => { reject(controller.signal.reason as Error) }, { once: true })
    })
    // A rejection nobody awaited yet must not surface as unhandled.
    aborted.catch(noop)
    // A fetch that throws synchronously is a rejection here, so it too becomes an engine failure.
    const sent = new Promise<Response>((resolve) => {
      resolve(external(url, { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit' }))
    })
    let response: Response
    try {
      response = await Promise.race([sent, aborted])
    } catch (error) {
      // A fetch that ignores its abort signal may still deliver a Response later; it is closed on arrival.
      sent.then((late) => { discard(late.body, controller.signal.reason) }, noop)
      throw failure(error)
    }
    const refused = refuse(response, url, policy)
    if (refused !== undefined) {
      release()
      discard(response.body, refused)
      throw fail(refused)
    }
    if (response.body === null || BODYLESS_STATUSES.has(response.status)) {
      release()
      return response
    }
    const reader = response.body.getReader()
    let received = 0
    const bounded = new ReadableStream<Uint8Array>({
      async pull(stream) {
        let next: ReadableStreamReadResult<Uint8Array>
        try {
          next = await Promise.race([reader.read(), aborted])
        } catch (error) {
          const wrapped = failure(error)
          reader.cancel(wrapped).catch(noop)
          throw wrapped
        }
        if (next.done) {
          release()
          stream.close()
          return
        }
        received += next.value.byteLength
        if (received > policy.responseByteLimit) {
          const exceeded = fail(new McpOAuthError('OAuth protocol response exceeds the configured byte bound', 'RESPONSE_BOUND'))
          release()
          controller.abort(exceeded)
          reader.cancel(exceeded).catch(noop)
          throw exceeded
        }
        stream.enqueue(next.value)
      },
      cancel(reason) {
        release()
        reader.cancel(reason).catch(noop)
      },
    })
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

/** Why a delivered response may not be handed to the SDK, if it may not. */
function refuse(response: Response, url: URL, policy: BoundedFetchPolicy): McpOAuthError | undefined {
  if (response.status >= 300 && response.status < 400) {
    return new McpOAuthError('OAuth protocol response was a redirect', 'NETWORK')
  }
  if (response.url !== '' && new URL(response.url).origin !== url.origin) {
    return new McpOAuthError('OAuth protocol response came from another origin', 'ENDPOINT_NOT_ALLOWED')
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > policy.responseByteLimit) {
    return new McpOAuthError('OAuth protocol response exceeds the configured byte bound', 'RESPONSE_BOUND')
  }
  return undefined
}

/** An engine error as-is; anything else becomes a `NETWORK` failure with a sanitized cause. */
function asEngineError(reason: unknown): McpOAuthError {
  return reason instanceof McpOAuthError ? reason : new McpOAuthError('OAuth protocol request failed', 'NETWORK', { cause: reason })
}
