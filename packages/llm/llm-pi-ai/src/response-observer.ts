/**
 * Attribution of the HTTP responses pi-ai receives through one shared `fetch`
 * to the model request that caused them.
 *
 * @module dsh-llm-pi-ai/response-observer
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { FetchFunction } from '@earendil-works/pi-ai'
import { parseRetryAfterMs } from './stream.ts'
import type { ObservedProviderResponse } from './stream.ts'

/** The latest provider response one model request received. */
interface RequestObservation {
  last: ObservedProviderResponse | undefined
}

/** One model request started under {@link ProviderResponseObserver.observe}. */
export interface ObservedRequest<T> {
  /** What starting the request returned. */
  readonly result: T
  /**
   * Read the latest provider response this request received.
   * @returns that response, or `undefined` before any arrives and after a
   *   later attempt of the same request started.
   */
  readonly lastResponse: () => ObservedProviderResponse | undefined
}

/**
 * A credential exchange a provider SDK sends through the same `fetch`, such as
 * the Anthropic SDK's workload-identity and OAuth token endpoint
 * `/v1/oauth/token`. Its response describes a credential, not the model request.
 */
const CREDENTIAL_EXCHANGE = /\/oauth\/token(?:[?#]|$)/

function requestUrl(input: Parameters<FetchFunction>[0]): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/**
 * Attributes each provider response to the model request that received it.
 * One {@link fetch} serves every request for the observer's lifetime, because
 * pi-ai keeps clients cached per `fetch` identity (the Anthropic
 * workload-identity federation client and its token cache); an async context
 * carries each request's own observation through pi-ai's work, so concurrent
 * requests never see each other's responses.
 */
export class ProviderResponseObserver {
  private readonly requests = new AsyncLocalStorage<RequestObservation>()

  /**
   * The `fetch` handed to pi-ai. It reads the global `fetch` when each request
   * starts, so a process-wide proxy dispatcher still applies, and records each
   * model response's status and requested retry delay before pi-ai consumes it.
   * A model request that fails without a response leaves no observation, so an
   * earlier attempt's response never describes it; credential exchanges and
   * requests outside {@link observe} pass through unrecorded.
   * @param input - the request target.
   * @param init - the request options.
   * @returns the global `fetch` response.
   */
  readonly fetch: FetchFunction = async (input, init) => {
    const observation = this.requests.getStore()
    if (observation === undefined || CREDENTIAL_EXCHANGE.test(requestUrl(input))) return await globalThis.fetch(input, init)
    observation.last = undefined
    const response = await globalThis.fetch(input, init)
    const retryAfterMs = parseRetryAfterMs(response.headers, Date.now())
    observation.last = { status: response.status, ...retryAfterMs === undefined ? {} : { retryAfterMs } }
    return response
  }

  /**
   * Start one model request so that every response its {@link fetch} calls
   * receive is attributed to it, including calls pi-ai makes after `start` returns.
   * @param start - starts the request.
   * @returns the started request and a reader for its latest response.
   */
  observe<T>(start: () => T): ObservedRequest<T> {
    const observation: RequestObservation = { last: undefined }
    return { result: this.requests.run(observation, start), lastResponse: () => observation.last }
  }
}
