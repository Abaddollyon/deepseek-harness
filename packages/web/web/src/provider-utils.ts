/** Shared helpers for native WebSearchProvider implementations. */

import {
  WebError,
  type WebSearchBatchOutcome,
  type WebSearchBatchRequest,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchSource,
} from './types.ts'

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\.+/u, '')
  return normalized.length > 0 && (hostname === normalized || hostname.endsWith(`.${normalized}`))
}

function sourceAllowed(source: WebSearchSource, request: WebSearchBatchRequest): boolean {
  let hostname: string
  try {
    const url = new URL(source.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    hostname = url.hostname.toLowerCase()
  } catch {
    return false
  }
  if (request.blockedDomains?.some(domain => domainMatches(hostname, domain)) === true) return false
  return request.allowedDomains === undefined
    || request.allowedDomains.some(domain => domainMatches(hostname, domain))
}

/** Apply provider-independent allowed/blocked hostname enforcement before results enter the web seam.
 * @param sources - provider-returned source candidates.
 * @param request - batch domain controls; blocked entries take precedence.
 * @returns only HTTP(S) sources permitted by both controls.
 */
export function filterWebSearchSourcesByDomains(
  sources: readonly WebSearchSource[],
  request: WebSearchBatchRequest,
): readonly WebSearchSource[] {
  return sources.filter(source => sourceAllowed(source, request))
}

/** Implement a provider's one-query method through its native batch path.
 * @param request - one provider-neutral search request.
 * @param signal - optional cancellation signal.
 * @param searchMany - provider-owned native batch operation.
 * @returns the one successful normalized provider result.
 */
export async function searchOneThroughBatch(
  request: WebSearchRequest,
  signal: AbortSignal | undefined,
  searchMany: (
    request: WebSearchBatchRequest,
    signal?: AbortSignal,
  ) => Promise<readonly WebSearchBatchOutcome[]>,
): Promise<WebSearchResult> {
  const [outcome] = await searchMany({
    queries: [request.query],
    ...request.maxResults === undefined ? {} : { maxResults: request.maxResults },
  }, signal)
  if (outcome?.result !== undefined) return outcome.result
  /* v8 ignore next -- native batch providers return one result or error per input query. */
  if (outcome?.error !== undefined) throw new WebError(outcome.error.message, outcome.error.code)
  /* v8 ignore next -- the exhaustive one-item outcome contract makes this unreachable. */
  throw new WebError('web search provider returned no outcome', 'WEB_PROVIDER_PROTOCOL')
}

/** Base behavior common to providers whose primary operation is a native batch. */
export abstract class NativeBatchSearchProvider implements WebSearchProvider {
  abstract readonly id: string

  /** Native runtimes resolve authentication only when an operation starts. */
  available(): boolean {
    return true
  }

  /** Run one query through the provider's native batch operation.
   * @param request - one provider-neutral search request.
   * @param signal - optional cancellation signal.
   * @returns the one successful normalized provider result.
   */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    return searchOneThroughBatch(request, signal, (batch, batchSignal) => this.searchMany(batch, batchSignal))
  }

  /** Run one ordered native provider batch.
   * @param request - ordered provider-neutral batch controls.
   * @param signal - optional cancellation signal.
   * @returns exactly one ordered result or safe error per input query.
   */
  abstract searchMany(
    request: WebSearchBatchRequest,
    signal?: AbortSignal,
  ): Promise<readonly WebSearchBatchOutcome[]>
}

/** Validate one positive integer deployment option.
 * @param name - diagnostic field name.
 * @param value - parsed configuration value.
 * @returns the validated value.
 */
export function positiveSafeIntegerConfig(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WebError(`${name} must be a positive safe integer`, 'WEB_INVALID_CONFIG')
  }
  return value
}

/** Validate one required non-empty deployment string.
 * @param name - diagnostic field name.
 * @param value - parsed configuration value.
 * @returns the validated value.
 */
export function nonEmptyConfigString(name: string, value: string): string {
  if (value.length === 0) throw new WebError(`${name} must not be empty`, 'WEB_INVALID_CONFIG')
  return value
}

/** Linked cancellation scope for one native provider operation. */
export interface NativeProviderAbortScope {
  readonly controller: AbortController
  /** Remove the caller listener after provider settlement. */
  dispose(): void
}

/** Create a provider-owned controller linked to one optional caller signal.
 * @param signal - optional caller cancellation signal.
 * @returns the provider controller and listener disposer.
 */
export function createNativeProviderAbortScope(signal?: AbortSignal): NativeProviderAbortScope {
  if (signal?.aborted === true) {
    throw new WebError('web search was cancelled', 'WEB_ABORTED', { cause: signal.reason })
  }
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort(signal?.reason) }
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    controller,
    dispose: () => signal?.removeEventListener('abort', onAbort),
  }
}
