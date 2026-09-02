/**
 * Service Definition for the web access capability seam (`ctx.web`): registries and provider-selecting execution for search and
 * fetch. Duplicate ids are rejected. At execution time, a configured provider must exist and
 * be usable; without one, exactly one usable provider is required, so selection never depends
 * on registration order.
 * @module @deepseek-ai/dsh-web
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { searchOneThroughBatch } from './provider-utils.ts'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchBatchOutcome,
  WebSearchBatchRequest,
  WebSearchMode,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { SearchCoordinator, type SearchCoordinatorTelemetry } from './search-coordinator.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export {
  createNativeProviderAbortScope,
  filterWebSearchSourcesByDomains,
  NativeBatchSearchProvider,
  nonEmptyConfigString,
  positiveSafeIntegerConfig,
  searchOneThroughBatch,
} from './provider-utils.ts'
export type { NativeProviderAbortScope } from './provider-utils.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchBatchError,
  WebSearchBatchOutcome,
  WebSearchBatchRequest,
  WebSearchLocation,
  WebSearchMode,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** The configured provider id for this capability, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the web seam. `searchProvider` / `fetchProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). Operational overrides such as environment variables
 * must feed these same fields rather than introduce a hidden priority chain.
 */
export interface WebRuntimeConfig {
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider?: string
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider?: string
  /** Maximum concurrent calls used for a legacy provider without native batching. */
  readonly legacySearchConcurrency?: number
  /** Freshness mode applied when a caller omits one. */
  readonly searchMode?: WebSearchMode
  /** Success-cache lifetime for cached and indexed searches. */
  readonly searchCacheTtlMs?: number
  /** Success-cache lifetime for live searches; zero disables settled-result caching. */
  readonly liveSearchCacheTtlMs?: number
  /** Maximum successful per-query results retained in the Host-scoped cache. */
  readonly searchCacheMaxEntries?: number
  /** Maximum active native provider batches; constrained to one or two. */
  readonly nativeBatchConcurrency?: number
}

/** Default bounded fan-out for providers that implement only one-query search. */
export const DEFAULT_LEGACY_SEARCH_CONCURRENCY = 4
/** Default provider-neutral freshness for callers that omit a mode. */
export const DEFAULT_SEARCH_MODE: WebSearchMode = 'cached'
/** Default success-cache lifetime for cached and indexed searches. */
export const DEFAULT_SEARCH_CACHE_TTL_MS = 300_000
/** Live searches do not retain settled results by default. */
export const DEFAULT_LIVE_SEARCH_CACHE_TTL_MS = 0
/** Default Host-scoped successful per-query cache bound. */
export const DEFAULT_SEARCH_CACHE_MAX_ENTRIES = 512
/** Default and hard maximum active native provider batches. */
export const DEFAULT_NATIVE_BATCH_CONCURRENCY = 2

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WebError(`${name} must be a positive safe integer`, 'WEB_INVALID_CONFIG')
  }
  return value
}

function nonnegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WebError(`${name} must be a nonnegative safe integer`, 'WEB_INVALID_CONFIG')
  }
  return value
}

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `WEB_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `WEB_PROVIDER_UNAVAILABLE`.
 */
export class WebRuntime extends Service {
  /**
   * Provider selection config. Operational env overrides feed the SAME fields:
   * `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` are equivalent to
   * `searchProvider` / `fetchProvider` and are NOT a hidden priority chain.
   */
  static Config: z<WebRuntimeConfig> = z.object({
    searchProvider: z.string(),
    fetchProvider: z.string(),
    legacySearchConcurrency: z.natural().min(1).default(DEFAULT_LEGACY_SEARCH_CONCURRENCY),
    searchMode: z.union(['cached', 'indexed', 'live'] as const).default(DEFAULT_SEARCH_MODE),
    searchCacheTtlMs: z.natural().default(DEFAULT_SEARCH_CACHE_TTL_MS),
    liveSearchCacheTtlMs: z.natural().default(DEFAULT_LIVE_SEARCH_CACHE_TTL_MS),
    searchCacheMaxEntries: z.natural().min(1).default(DEFAULT_SEARCH_CACHE_MAX_ENTRIES),
    nativeBatchConcurrency: z.natural().min(1).max(2).default(DEFAULT_NATIVE_BATCH_CONCURRENCY),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderId: string | undefined
  private readonly fetchProviderId: string | undefined
  private readonly legacySearchConcurrency: number
  private readonly searchMode: WebSearchMode
  private readonly coordinator: SearchCoordinator

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web')
    this.searchProviderId = config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER
    this.fetchProviderId = config.fetchProvider ?? process.env.DSH_WEB_FETCH_PROVIDER
    const legacySearchConcurrency = config.legacySearchConcurrency ?? DEFAULT_LEGACY_SEARCH_CONCURRENCY
    if (!Number.isInteger(legacySearchConcurrency) || legacySearchConcurrency < 1) {
      throw new WebError('legacySearchConcurrency must be a positive integer', 'WEB_INVALID_CONFIG')
    }
    this.legacySearchConcurrency = legacySearchConcurrency
    this.searchMode = config.searchMode ?? DEFAULT_SEARCH_MODE
    const searchCacheTtlMs = nonnegativeInteger(
      'searchCacheTtlMs',
      config.searchCacheTtlMs ?? DEFAULT_SEARCH_CACHE_TTL_MS,
    )
    const liveSearchCacheTtlMs = nonnegativeInteger(
      'liveSearchCacheTtlMs',
      config.liveSearchCacheTtlMs ?? DEFAULT_LIVE_SEARCH_CACHE_TTL_MS,
    )
    const searchCacheMaxEntries = positiveInteger(
      'searchCacheMaxEntries',
      config.searchCacheMaxEntries ?? DEFAULT_SEARCH_CACHE_MAX_ENTRIES,
    )
    const nativeBatchConcurrency = positiveInteger(
      'nativeBatchConcurrency',
      config.nativeBatchConcurrency ?? DEFAULT_NATIVE_BATCH_CONCURRENCY,
    )
    if (nativeBatchConcurrency > 2) {
      throw new WebError('nativeBatchConcurrency must be at most 2', 'WEB_INVALID_CONFIG')
    }
    this.coordinator = new SearchCoordinator({
      cacheTtlMs: searchCacheTtlMs,
      liveCacheTtlMs: liveSearchCacheTtlMs,
      cacheMaxEntries: searchCacheMaxEntries,
      nativeBatchConcurrency,
    }, (telemetry) => { this.observeSearch(telemetry) })
    ctx.effect(() => () => this.coordinator.dispose(), 'web.searchCoordinator()')
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam enforces `request.maxResults` on the result:
   * if the provider over-returns, `sources[]` is truncated and `truncated` set.
   * @param request - the query and optional result limit.
   * @param signal - optional caller cancellation linked to shared provider work.
   * @returns the provider's results, capped to `request.maxResults`.
   */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    return searchOneThroughBatch(request, signal, (batch, batchSignal) => this.searchMany(batch, batchSignal))
  }

  /**
   * Run an ordered query batch after selecting one provider. Native batch
   * providers receive one call; legacy providers use bounded parallel search.
   * Host-scoped cache, singleflight, and a two-batch native scheduler coordinate
   * concurrent callers. Provider failures become per-query safe outcomes while caller cancellation
   * remains a thrown `WEB_ABORTED` error.
   * @param request - ordered queries and provider-neutral search controls.
   * @param signal - optional caller cancellation signal.
   * @returns one normalized outcome for every input query in input order.
   */
  async searchMany(request: WebSearchBatchRequest, signal?: AbortSignal): Promise<readonly WebSearchBatchOutcome[]> {
    throwIfAborted(signal)
    const provider = await resolveProvider({
      providers: this.searchProviders,
      ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
    })
    throwIfAborted(signal)
    const resolvedRequest = { ...request, mode: request.mode ?? this.searchMode }
    if (hasNativeBatch(provider)) {
      return this.coordinator.search({
        providerId: provider.id,
        native: true,
        request: resolvedRequest,
        run: async (batch, sharedSignal) => normalizeBatchOutcomes(
          batch,
          await callNativeMany(provider, batch, sharedSignal),
        ),
      }, signal)
    }
    return this.coordinator.search({
      providerId: provider.id,
      native: false,
      request: resolvedRequest,
      run: async (batch, sharedSignal) => normalizeBatchOutcomes(
        batch,
        await searchLegacyMany(provider, batch, this.legacySearchConcurrency, sharedSignal),
      ),
    }, signal)
  }

  private observeSearch(telemetry: SearchCoordinatorTelemetry): void {
    this.ctx.logger.debug(
      `web search provider=${telemetry.providerId} queries=${telemetry.queryCount} cache_hits=${telemetry.cacheHits} `
      + `singleflight_hits=${telemetry.singleflightHits} submitted=${telemetry.submittedQueries} `
      + `succeeded=${telemetry.succeeded} failed=${telemetry.failed} aborted=${telemetry.aborted} `
      + `duration_ms=${telemetry.durationMs}`,
    )
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   * @param request - the URL plus retrieval options.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retrieval outcome; non-2xx responses resolve descriptively.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const provider = await resolveProvider({
      providers: this.fetchProviders,
      ...this.fetchProviderId !== undefined ? { configuredId: this.fetchProviderId } : {},
    })
    return provider.fetch(request, signal)
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean | Promise<boolean>
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
async function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): Promise<P> {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!await provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usability = await Promise.all([...providers.values()].map(async provider => ({
    provider,
    available: await provider.available(),
  })))
  const usable = usability.filter(entry => entry.available).map(entry => entry.provider)
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new WebError('web search was cancelled', 'WEB_ABORTED', { cause: signal.reason })
  }
}

function batchError(error: unknown): { code: string; message: string } {
  if (error instanceof WebError && error.code !== 'WEB_PROVIDER_ERROR') {
    return { code: error.code, message: error.message }
  }
  return { code: 'WEB_PROVIDER_ERROR', message: 'web search provider failed' }
}

interface NativeBatchProvider extends WebSearchProvider {
  searchMany: NonNullable<WebSearchProvider['searchMany']>
}

function hasNativeBatch(provider: WebSearchProvider): provider is NativeBatchProvider {
  return provider.searchMany !== undefined
}

async function callNativeMany(
  provider: NativeBatchProvider,
  request: WebSearchBatchRequest,
  signal: AbortSignal | undefined,
): Promise<readonly WebSearchBatchOutcome[]> {
  try {
    return await provider.searchMany(request, signal)
  } catch (error: unknown) {
    throwIfAborted(signal)
    const normalized = batchError(error)
    return request.queries.map(query => ({ query, error: normalized }))
  }
}

async function searchLegacyMany(
  provider: WebSearchProvider,
  request: WebSearchBatchRequest,
  concurrency: number,
  signal: AbortSignal | undefined,
): Promise<readonly WebSearchBatchOutcome[]> {
  const outcomes: WebSearchBatchOutcome[] = Array.from({ length: request.queries.length })
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < request.queries.length) {
      const index = cursor
      cursor += 1
      const query = request.queries[index]
      if (query === undefined) return
      throwIfAborted(signal)
      try {
        const searchRequest = {
          query,
          ...request.maxResults === undefined ? {} : { maxResults: request.maxResults },
        }
        const result = await provider.search(searchRequest, signal)
        outcomes[index] = { query, result }
      } catch (error: unknown) {
        throwIfAborted(signal)
        outcomes[index] = { query, error: batchError(error) }
      }
    }
  }
  const workerCount = Math.min(concurrency, request.queries.length)
  const workers = Array.from({ length: workerCount }, () => worker())
  const settled = await Promise.allSettled(workers)
  throwIfAborted(signal)
  const rejected = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
  if (rejected !== undefined) throw rejected.reason
  return outcomes
}

function protocolFailure(query: string): WebSearchBatchOutcome {
  return {
    query,
    error: {
      code: 'WEB_PROVIDER_PROTOCOL',
      message: 'web search provider returned an invalid batch outcome',
    },
  }
}

function normalizeBatchOutcomes(
  request: WebSearchBatchRequest,
  outcomes: readonly WebSearchBatchOutcome[],
): readonly WebSearchBatchOutcome[] {
  return request.queries.map((query, index) => {
    const outcome = outcomes[index]
    if (outcome === undefined || outcome.query !== query) return protocolFailure(query)
    if ((outcome.result === undefined) === (outcome.error === undefined)) return protocolFailure(query)
    if (outcome.result !== undefined) {
      return { query, result: normalizeSearchResult(outcome.result, request.maxResults) }
    }
    if (outcome.error !== undefined) return { query, error: outcome.error }
    return protocolFailure(query)
  })
}

interface NormalizedHttpUrl {
  readonly key: string
  readonly url: string
}

function normalizedHttpUrl(value: string): NormalizedHttpUrl | undefined {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    parsed.hash = ''
    const key = parsed.href
    const url = parsed.pathname === '/' && parsed.search.length === 0
      && /^https?:\/\/[^/?#]+(?:[?#]|$)/iu.test(value)
      ? parsed.origin
      : key
    return { key, url }
  } catch {
    return undefined
  }
}

/** Normalize citeable URLs, deduplicate sources, and enforce `maxResults`. */
function normalizeSearchResult(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  const seen = new Set<string>()
  const sources = []
  for (const source of result.sources) {
    const normalized = normalizedHttpUrl(source.url)
    if (normalized === undefined || seen.has(normalized.key)) continue
    seen.add(normalized.key)
    sources.push({ ...source, url: normalized.url })
  }
  const capped = maxResults === undefined ? sources : sources.slice(0, maxResults)
  return {
    ...result,
    sources: capped,
    truncated: result.truncated || capped.length < sources.length,
  }
}

export default WebRuntime
