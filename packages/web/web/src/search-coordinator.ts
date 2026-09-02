/** Host-scoped cache, coalescing, scheduling, and cancellation for web search. */

import { WebError } from './types.ts'
import type {
  WebSearchBatchOutcome,
  WebSearchBatchRequest,
  WebSearchMode,
  WebSearchResult,
} from './types.ts'

/** Validated deployment controls for host-scoped search coordination. */
export interface SearchCoordinatorConfig {
  readonly cacheTtlMs: number
  readonly liveCacheTtlMs: number
  readonly cacheMaxEntries: number
  readonly nativeBatchConcurrency: number
}

/** Aggregate telemetry that deliberately excludes queries, domains, locations, and URLs. */
export interface SearchCoordinatorTelemetry {
  readonly providerId: string
  readonly queryCount: number
  readonly cacheHits: number
  readonly singleflightHits: number
  readonly submittedQueries: number
  readonly succeeded: number
  readonly failed: number
  readonly aborted: boolean
  readonly durationMs: number
}

/** One provider dispatch selected by the owning WebRuntime. */
export interface SearchCoordinatorDispatch {
  readonly providerId: string
  readonly native: boolean
  readonly request: WebSearchBatchRequest
  readonly run: (
    request: WebSearchBatchRequest,
    signal: AbortSignal,
  ) => Promise<readonly WebSearchBatchOutcome[]>
}

interface CacheEntry {
  readonly result: WebSearchResult
  readonly expiresAt: number
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

interface InflightEntry {
  readonly key: string
  readonly query: string
  readonly deferred: Deferred<WebSearchBatchOutcome>
  waiters: number
  job?: SearchJob
}

interface SearchJob {
  readonly native: boolean
  readonly request: WebSearchBatchRequest
  readonly entries: readonly InflightEntry[]
  readonly controller: AbortController
  readonly deferred: Deferred<void>
  readonly run: SearchCoordinatorDispatch['run']
  state: 'queued' | 'active' | 'settled'
}

interface EntryReference {
  readonly entry: InflightEntry
  readonly outcome: Promise<WebSearchBatchOutcome>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function webAbort(reason: unknown): WebError {
  return new WebError('web search was cancelled', 'WEB_ABORTED', { cause: reason })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw webAbort(signal.reason)
}

function normalizedStrings(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return []
  return [...new Set(values.map(value => value.trim().toLowerCase()))].sort()
}

function searchKey(providerId: string, request: WebSearchBatchRequest, query: string): string {
  const location = request.location
  return JSON.stringify([
    providerId,
    request.mode ?? null,
    request.maxResults ?? null,
    normalizedStrings(request.allowedDomains),
    normalizedStrings(request.blockedDomains),
    location === undefined
      ? null
      : [location.country ?? null, location.region ?? null, location.city ?? null, location.timezone ?? null],
    query,
  ])
}

function cancellationOutcome(query: string): WebSearchBatchOutcome {
  return { query, error: { code: 'WEB_ABORTED', message: 'web search was cancelled' } }
}

function providerFailureOutcome(query: string): WebSearchBatchOutcome {
  return { query, error: { code: 'WEB_PROVIDER_ERROR', message: 'web search provider failed' } }
}

/** Coordinates all searches owned by one Host-scoped WebRuntime. */
export class SearchCoordinator {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, InflightEntry>()
  private readonly queuedNative: SearchJob[] = []
  private readonly activeJobs = new Set<SearchJob>()
  private activeNative = 0
  private disposed = false
  private disposal?: Promise<void>

  constructor(
    private readonly config: SearchCoordinatorConfig,
    private readonly observe: (telemetry: SearchCoordinatorTelemetry) => void,
  ) {}

  /**
   * Resolve cache and singleflight entries, dispatch new misses, and retain input order.
   * @param dispatch - selected provider identity, request, and one provider execution closure.
   * @param signal - caller cancellation; shared provider work survives while another waiter remains.
   * @returns one outcome for every input query.
   */
  async search(
    dispatch: SearchCoordinatorDispatch,
    signal?: AbortSignal,
  ): Promise<readonly WebSearchBatchOutcome[]> {
    const startedAt = Date.now()
    const counters = { cacheHits: 0, singleflightHits: 0, submittedQueries: 0 }
    let aborted = false
    let completed: readonly WebSearchBatchOutcome[] = []
    try {
      if (this.disposed) throw webAbort('web runtime disposed')
      throwIfAborted(signal)
      const references: EntryReference[] = []
      const created: InflightEntry[] = []
      for (const query of dispatch.request.queries) {
        const key = searchKey(dispatch.providerId, dispatch.request, query)
        const cached = this.cachedOutcome(key, query)
        if (cached !== undefined) {
          counters.cacheHits += 1
          references.push({ entry: this.cachedReference(key, query, cached), outcome: Promise.resolve(cached) })
          continue
        }
        const existing = this.inflight.get(key)
        if (existing !== undefined) {
          existing.waiters += 1
          counters.singleflightHits += 1
          references.push({ entry: existing, outcome: existing.deferred.promise })
          continue
        }
        const entry: InflightEntry = { key, query, deferred: deferred(), waiters: 1 }
        this.inflight.set(key, entry)
        created.push(entry)
        references.push({ entry, outcome: entry.deferred.promise })
      }
      counters.submittedQueries = created.length
      if (created.length > 0) this.dispatchCreated(dispatch, created)
      completed = await this.awaitReferences(references, signal)
      return completed
    } catch (error: unknown) {
      aborted = signal?.aborted === true || (error instanceof WebError && error.code === 'WEB_ABORTED')
      throw error
    } finally {
      const elapsed = Math.max(0, Date.now() - startedAt)
      aborted ||= completed.some(outcome => outcome.error?.code === 'WEB_ABORTED')
      this.safeObserve({
        providerId: dispatch.providerId,
        queryCount: dispatch.request.queries.length,
        ...counters,
        succeeded: completed.filter(outcome => outcome.result !== undefined).length,
        failed: completed.filter(outcome => outcome.error !== undefined).length,
        aborted,
        durationMs: elapsed,
      })
    }
  }

  /** Abort queued and active work, clear retained results, and await provider quiescence. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.cache.clear()
    for (const job of [...this.queuedNative]) this.cancelQueued(job, 'web runtime disposed')
    for (const job of this.activeJobs) {
      this.detachInflight(job)
      job.controller.abort('web runtime disposed')
    }
    this.disposal = Promise.all([...this.activeJobs].map(job => job.deferred.promise)).then(() => {})
    return this.disposal
  }

  private cachedOutcome(key: string, query: string): WebSearchBatchOutcome | undefined {
    const cached = this.cache.get(key)
    if (cached === undefined) return undefined
    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(key)
      return undefined
    }
    this.cache.delete(key)
    this.cache.set(key, cached)
    return { query, result: cached.result }
  }

  private cachedReference(key: string, query: string, outcome: WebSearchBatchOutcome): InflightEntry {
    return { key, query, deferred: { promise: Promise.resolve(outcome), resolve: () => {} }, waiters: 0 }
  }

  private dispatchCreated(dispatch: SearchCoordinatorDispatch, entries: readonly InflightEntry[]): void {
    const request = { ...dispatch.request, queries: entries.map(entry => entry.query) }
    const job: SearchJob = {
      native: dispatch.native,
      request,
      entries,
      controller: new AbortController(),
      deferred: deferred(),
      run: dispatch.run,
      state: dispatch.native ? 'queued' : 'active',
    }
    for (const entry of entries) entry.job = job
    if (dispatch.native) {
      this.queuedNative.push(job)
      this.drainNativeQueue()
    } else {
      this.startJob(job)
    }
  }

  private drainNativeQueue(): void {
    while (this.activeNative < this.config.nativeBatchConcurrency) {
      const job = this.queuedNative.shift()
      if (job === undefined) return
      if (job.state !== 'queued') continue
      this.startJob(job)
    }
  }

  private startJob(job: SearchJob): void {
    job.state = 'active'
    this.activeJobs.add(job)
    if (job.native) this.activeNative += 1
    void this.executeJob(job)
  }

  private async executeJob(job: SearchJob): Promise<void> {
    let outcomes: readonly WebSearchBatchOutcome[]
    try {
      outcomes = await job.run(job.request, job.controller.signal)
      if (job.controller.signal.aborted) {
        outcomes = job.entries.map(entry => cancellationOutcome(entry.query))
      }
    } catch (_providerFailure) {
      outcomes = job.entries.map(entry => job.controller.signal.aborted
        ? cancellationOutcome(entry.query)
        : providerFailureOutcome(entry.query))
    }
    for (let index = 0; index < job.entries.length; index += 1) {
      const entry = job.entries[index]
      if (entry === undefined) continue
      const outcome = outcomes[index] ?? providerFailureOutcome(entry.query)
      const mapped = outcome.query === entry.query ? outcome : providerFailureOutcome(entry.query)
      if (mapped.result !== undefined) this.cacheResult(entry.key, job.request.mode, mapped.result)
      if (this.inflight.get(entry.key) === entry) this.inflight.delete(entry.key)
      entry.deferred.resolve(mapped)
    }
    job.state = 'settled'
    this.activeJobs.delete(job)
    if (job.native) this.activeNative -= 1
    job.deferred.resolve()
    if (job.native) this.drainNativeQueue()
  }

  private cacheResult(key: string, mode: WebSearchMode | undefined, result: WebSearchResult): void {
    const ttlMs = mode === 'live' ? this.config.liveCacheTtlMs : this.config.cacheTtlMs
    if (ttlMs === 0) return
    this.cache.delete(key)
    this.cache.set(key, { result, expiresAt: Date.now() + ttlMs })
    while (this.cache.size > this.config.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private async awaitReferences(
    references: readonly EntryReference[],
    signal: AbortSignal | undefined,
  ): Promise<readonly WebSearchBatchOutcome[]> {
    const pending = Promise.all(references.map(reference => reference.outcome))
    if (signal === undefined) {
      const outcomes = await pending
      this.release(references)
      return outcomes
    }
    throwIfAborted(signal)
    let rejectAbort!: (error: WebError) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const onAbort = (): void => { rejectAbort(webAbort(signal.reason)) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const outcomes = await Promise.race([pending, cancelled])
      throwIfAborted(signal)
      this.release(references)
      return outcomes
    } catch (error: unknown) {
      if (!signal.aborted) {
        this.release(references)
        throw error
      }
      const orphaned = this.release(references)
      await Promise.all(orphaned.map(job => job.deferred.promise))
      throw webAbort(signal.reason)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private release(references: readonly EntryReference[]): SearchJob[] {
    const orphaned = new Set<SearchJob>()
    for (const { entry } of references) {
      if (entry.job === undefined) continue
      entry.waiters -= 1
      const job = entry.job
      if (job.entries.every(candidate => candidate.waiters === 0)) orphaned.add(job)
    }
    for (const job of orphaned) {
      if (job.state === 'queued') this.cancelQueued(job, 'all search waiters cancelled')
      else if (job.state === 'active') {
        this.detachInflight(job)
        job.controller.abort('all search waiters cancelled')
      }
    }
    return [...orphaned]
  }

  private detachInflight(job: SearchJob): void {
    for (const entry of job.entries) {
      if (this.inflight.get(entry.key) === entry) this.inflight.delete(entry.key)
    }
  }

  private cancelQueued(job: SearchJob, reason: string): void {
    if (job.state !== 'queued') return
    job.state = 'settled'
    job.controller.abort(reason)
    const index = this.queuedNative.indexOf(job)
    if (index >= 0) this.queuedNative.splice(index, 1)
    for (const entry of job.entries) {
      if (this.inflight.get(entry.key) === entry) this.inflight.delete(entry.key)
      entry.deferred.resolve(cancellationOutcome(entry.query))
    }
    job.deferred.resolve()
  }

  private safeObserve(telemetry: SearchCoordinatorTelemetry): void {
    try {
      this.observe(telemetry)
    } catch (_telemetryFailure) {
      // Aggregate telemetry is observational and cannot alter search behavior.
    }
  }
}
