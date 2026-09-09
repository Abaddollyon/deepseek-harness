/** Shared live/prepared observations for Session page and lifecycle consumers. */

import type { Context } from '@deepseek-ai/cordis'
import { isAppendSurfaceEvent, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId , SessionLogOffset as SessionLogOffsetType , SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionCheckpoint, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE, SessionQueryError } from './config.ts'
import { readColdSessionLog, type ColdSessionLog } from './cold-read.ts'

/**
 * How many times a cold tail refolds when the durable revision moved under it.
 * A log that keeps moving declines to the complete preparation path rather than publishing a
 * revision that does not describe the observed events.
 */
const COLD_TAIL_REVISION_ATTEMPTS = 3

/** The three services one cold tail fold reads, resolved once by the caller. */
interface ColdTailServices {
  readonly persistence: SessionPersistence
  readonly registry: SessionProjectionRegistry
  readonly cache: SessionProjectionCache
}

/** One exact immutable Session cut retained for the caller's read lifetime. */
export interface SessionObservation extends Disposable {
  /** Whether the cut came from an attached Session, retained preparation, or keyed cold tail. */
  readonly source: 'live' | 'prepared' | 'cold'
  /** Immutable Session identity metadata. */
  readonly header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffsetType
  /**
   * Immutable contiguous events at {@link cursor}. A live observation
   * materializes this array on first read, so a consumer that reads only the
   * header, cursor, or projections never copies the log.
   */
  readonly events: readonly SessionEvent[]
  /** Last observed event seq, or -1 for an empty log. */
  readonly cursor: SessionSeqCursor
  /** Durable source revision for a cold prepared observation. */
  readonly revision?: SessionPersistenceRevision
  /** Exact projection baseline at {@link cursor}, when the registry is mounted. */
  readonly projections?: ProjectionSnapshot
  /**
   * Retain the same immutable cut for another Host owner.
   * @returns an independently disposable lease over this observation.
   */
  retain(): SessionObservation
}

/** Projection work and cancellation requested for one exact observation. */
export interface SessionObservationOptions {
  /** Optional cancellation while resolving a cold source. */
  readonly signal?: AbortSignal
  /** Whether to compute every projection or leave projection state untouched. */
  readonly projectionMode?: 'all' | 'none'
  /** Prefer the keyed projection-cache tail for detached history opening. */
  readonly historyTail?: boolean
  /** Requested message page size; used to choose a sufficiently wide cold read. */
  readonly maxMessages?: number
}

/**
 * One reusable cold observation: an unpublished restored Session plus the
 * exact balanced log it represents, valid while the producing persistence
 * instance still reports the same revision.
 */
interface PreparedEntry {
  /** The persistence instance whose `stat` produced {@link revision}; revisions from another instance are incomparable. */
  readonly persistence: SessionPersistence
  /** Durable revision observed by `stat` immediately before the log read. */
  readonly revision: SessionPersistenceRevision
  /** Unpublished Session restored from the balanced log; never entered into the store. */
  readonly session: Session
  /** Immutable balanced log (stored events plus in-memory interrupted-turn closers). */
  readonly events: readonly SessionEvent[]
  /** Active observation leases; a pinned entry (`refs > 0`) is never evicted. */
  refs: number
}

/**
 * Builds point observations without a corpus listing preflight.
 *
 * Cold reads are cached per session id, keyed by the persistence instance and
 * the `stat` revision observed before the log read: an unchanged revision
 * reuses the restored Session without re-reading the log. The cache is bounded
 * (least-recently-used unpinned entries are evicted past the capacity), and
 * entries pinned by active leases survive eviction and replacement — a lease's
 * cut stays valid for the lease lifetime even after a newer revision lands.
 */
export class SessionObservationReader {
  private readonly cache = new Map<SessionId, PreparedEntry>()

  /**
   * @param ctx - context carrying Session and optional persistence/projection services.
   * @param cacheCapacity - maximum unpinned cold observations retained for reuse.
   */
  constructor(
    private readonly ctx: Context,
    private readonly cacheCapacity: number = SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  ) {}

  /**
   * Observe one live-preferred Session and retain a cold preparation until disposal.
   * @param sessionId - logical Session identity.
   * @param options - cancellation and all-or-none projection computation for this read.
   * @returns one exact immutable observation.
   */
  async read(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    const { signal, projectionMode = 'all' } = options
    for (;;) {
      throwIfObservationAborted(signal)
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) return this.live(live, projectionMode)
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw notFound(sessionId)
      if (options.historyTail === true && projectionMode === 'all') {
        const cold = await this.coldTail(sessionId, signal, options.maxMessages ?? 50)
        if (cold !== undefined) return cold
      }

      const snapshot = await this.statSource(persistence, sessionId, signal)
      const attachedDuringStat = this.ctx.sessions.get(sessionId)
      if (attachedDuringStat !== undefined) return this.live(attachedDuringStat, projectionMode)
      let entry = this.cachedEntry(persistence, sessionId, snapshot.revision)
      if (entry === undefined) {
        const loaded = await this.loadSource(persistence, sessionId, signal)
        throwIfObservationAborted(signal)
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined) return this.live(attached, projectionMode)
        // The handle marks persisted events as adoptable; synthetic closers
        // are owned by this read, so the combined seed needs no copy.
        const seed = loaded.events
        let session: Session
        try {
          session = this.ctx.sessions.prepare(sessionId, {
            seed,
            meta: structuredClone(loaded.header),
            inheritedEventCount: loaded.inheritedEventCount,
            eventState: loaded.eventState,
          })
        } catch (error: unknown) {
          // The store rejects an id with a live owner: that owner is the
          // fresher source, so retry the live path. Any other rejection means
          // the stored log failed restore validation.
          if (this.ctx.sessions.get(sessionId) !== undefined) continue
          throw new SessionQueryError(
            `stored session "${sessionId}" is corrupt: ${errorMessage(error)}`,
            'SESSION_QUERY_CORRUPT_SESSION',
            { cause: error },
          )
        }
        entry = {
          persistence,
          revision: snapshot.revision,
          session,
          events: Object.freeze(seed),
          refs: 0,
        }
        this.store(sessionId, entry)
      }

      let projections: ProjectionSnapshot | undefined
      try {
        projections = projectionMode === 'none' ? undefined : this.preparedProjections(entry)
      } catch (error: unknown) {
        throw new SessionQueryError(
          `failed to project session "${sessionId}": ${errorMessage(error)}`,
          'SESSION_QUERY_CORRUPT_SESSION',
          { cause: error },
        )
      }
      return this.preparedLease(sessionId, entry, projections)
    }
  }

  /** Observe the stored snapshot, mapping absence and backend failures to the query taxonomy. */
  private async statSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<SessionPersistenceSnapshot> {
    let snapshot: SessionPersistenceSnapshot | undefined
    try {
      snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
    throwIfObservationAborted(signal)
    if (snapshot === undefined) throw notFound(sessionId)
    if (snapshot.header.id !== sessionId) {
      throw new SessionQueryError(
        `session persistence returned "${snapshot.header.id}" for "${sessionId}"`,
        'SESSION_QUERY_SOURCE_CONFLICT',
      )
    }
    return snapshot
  }

  /** Read the complete balanced cold log, mapping backend failures to the query taxonomy. */
  private async loadSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
  ): Promise<ColdSessionLog> {
    try {
      return await readColdSessionLog(persistence, sessionId, signal)
    } catch (error: unknown) {
      throwIfObservationAborted(signal)
      throw mapPersistenceFailure(sessionId, error)
    }
  }

  /** Return a still-valid cached entry and mark it most recently used. */
  private cachedEntry(
    persistence: SessionPersistence,
    sessionId: SessionId,
    revision: SessionPersistenceRevision,
  ): PreparedEntry | undefined {
    const cached = this.cache.get(sessionId)
    if (cached === undefined || cached.persistence !== persistence || cached.revision !== revision) {
      return undefined
    }
    this.cache.delete(sessionId)
    this.cache.set(sessionId, cached)
    return cached
  }

  /** Insert or replace the entry for one id, then evict past the capacity. */
  private store(sessionId: SessionId, entry: PreparedEntry): void {
    // Replacing a stale revision only drops the map's reference; live leases
    // keep the old entry alive through their own references.
    this.cache.delete(sessionId)
    this.cache.set(sessionId, entry)
    this.evictPastCapacity(entry)
  }

  /**
   * Evict oldest unpinned entries until the cache fits its capacity again.
   * Runs on store and whenever a lease release unpins an entry, so leases
   * that pinned every candidate cannot leave the cache over budget for good.
   * @param keep - the entry being stored, about to be leased; never evicted.
   */
  private evictPastCapacity(keep?: PreparedEntry): void {
    if (this.cache.size <= this.cacheCapacity) return
    for (const [id, candidate] of this.cache) {
      if (candidate === keep || candidate.refs > 0) continue
      this.cache.delete(id)
      if (this.cache.size <= this.cacheCapacity) return
    }
  }

  /** Build one disposable lease over a cached entry, pinning it until every lease releases. */
  private preparedLease(
    sessionId: SessionId,
    entry: PreparedEntry,
    projections: ProjectionSnapshot | undefined,
  ): SessionObservation {
    entry.refs += 1
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'prepared',
        header: entry.session.header,
        inheritedEventCount: entry.session.inheritedEventCount,
        events: entry.events,
        cursor: entry.events.at(-1)?.seq ?? -1,
        revision: entry.revision,
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${sessionId}" is disposed`)
          entry.refs += 1
          return lease()
        },
        [Symbol.dispose]: () => {
          if (disposed) return
          disposed = true
          entry.refs -= 1
          if (entry.refs === 0) this.evictPastCapacity()
        },
      }
    }
    return lease()
  }

  /**
   * Open one detached history tail from the durable snapshot, the projection
   * cache, and a suffix read, or decline so the caller falls back to the
   * always-correct complete preparation path.
   *
   * The point snapshot precedes the suffix read, so an append or an artifact
   * replacement in between would publish a revision that does not describe the
   * events this observation carries. The revision is therefore revalidated
   * after the fold, and a log that keeps moving under a bounded number of
   * attempts declines instead of publishing an incoherent cut.
   */
  private async coldTail(
    sessionId: SessionId,
    signal: AbortSignal | undefined,
    maxMessages: number,
  ): Promise<SessionObservation | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    const registry = this.ctx.get('sessionProjections')
    const cache = this.ctx.get('sessionProjectionCache')
    if (persistence === undefined || registry === undefined || cache === undefined) return undefined
    try {
      return await this.coldAttempts({ persistence, registry, cache }, sessionId, maxMessages, signal)
    } catch (error: unknown) {
      // A backend that rejects because the caller cancelled must read as
      // cancellation here, exactly as a cancelled read does.
      throwIfObservationAborted(signal)
      throw error
    }
  }

  /**
   * Fold the cold tail until it is coherent with an unmoved durable revision.
   * @param services - the persistence, projection registry, and cache resolved by the caller.
   * @param sessionId - logical Session identity being observed.
   * @param maxMessages - requested opening page size.
   * @param signal - optional cancellation for the cold reads.
   * @returns the cold observation, or undefined to fall back to the complete preparation path.
   */
  private async coldAttempts(
    services: ColdTailServices,
    sessionId: SessionId,
    maxMessages: number,
    signal: AbortSignal | undefined,
  ): Promise<SessionObservation | undefined> {
    const { persistence } = services
    for (let attempt = 0; attempt < COLD_TAIL_REVISION_ATTEMPTS; attempt += 1) {
      const found = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
      throwIfObservationAborted(signal)
      if (found === undefined || found.header.isSeeded) return undefined
      const folded = await this.coldFold(services, sessionId, found, maxMessages, signal)
      if (folded === undefined) return undefined
      // A Session that attached during the cold I/O owns sequences this
      // detached cut cannot see; publishing the cut would open the follow
      // stream at a cursor the live event feed has already passed.
      if (this.ctx.sessions.get(sessionId) !== undefined) {
        folded[Symbol.dispose]()
        return undefined
      }
      const current = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
      throwIfObservationAborted(signal)
      if (this.ctx.sessions.get(sessionId) !== undefined) {
        folded[Symbol.dispose]()
        return undefined
      }
      if (current !== undefined && current.revision === found.revision) return folded
      folded[Symbol.dispose]()
    }
    return undefined
  }

  /**
   * Fold one cold observation over the narrowest suffix that still contains the
   * complete opening page.
   * @param services - the persistence, projection registry, and cache resolved by the caller.
   * @param sessionId - logical Session identity being observed.
   * @param found - the point snapshot whose revision this fold is bound to.
   * @param maxMessages - requested opening page size.
   * @param signal - optional cancellation for suffix reads.
   * @returns the cold observation, or undefined when the registry serves no unit.
   */
  private async coldFold(
    services: ColdTailServices,
    sessionId: SessionId,
    found: SessionPersistenceSnapshot,
    maxMessages: number,
    signal: AbortSignal | undefined,
  ): Promise<SessionObservation | undefined> {
    const { persistence, registry, cache } = services
    const loaded = await readColdSessionLog(persistence, sessionId, signal)
    throwIfObservationAborted(signal)
    // The handle validates and migrates the complete generation before any suffix is projected.
    deepFreeze(loaded.header)
    const frozenFrom = loaded.eventState === 'shared-frozen' ? loaded.persistedEventCount : 0
    for (const event of loaded.events.slice(frozenFrom)) deepFreeze(event)
    let rows: ProjectionCheckpoint = cache.checkpointFor(loaded.header, loaded.inheritedEventCount) ?? {}
    const restoreFloor = registry.restoreFloor(rows)
    if (restoreFloor === undefined) return undefined

    // A projection restore floor is not a history-page floor. Widen the read
    // until the complete append-surface message group at the page boundary is
    // present; otherwise paginate() would report a false short page/hasMore.
    let base = restoreFloor
    let width = Math.max(8, maxMessages * 4)
    for (;;) {
      throwIfObservationAborted(signal)
      const suffix = {
        meta: loaded.header,
        inheritedEventCount: loaded.inheritedEventCount,
        fromSeq: base,
        events: Object.freeze(loaded.events.slice(base)),
      }
      throwIfObservationAborted(signal)
      // Cached rows are bound to ONE stored lifecycle, and the registry's
      // restore only checks version and watermark — never identity. Revalidate
      // the rows against the header this suffix actually came from, so an
      // artifact replaced between the point snapshot and this read cannot seed
      // projections from the previous lifecycle's rows.
      rows = cache.checkpointFor(suffix.meta, suffix.inheritedEventCount) ?? {}
      const safeFloor = registry.restoreFloor(rows) ?? SessionLogOffset(0)
      if (base > safeFloor) { base = safeFloor; continue }
      // A row claiming events this read does not contain is stale-by-shrink or
      // future. Only the complete log can discard one, so go there in a single
      // step instead of halving the anchor across repeated whole-file reads.
      if (base > 0 && claimsBeyond(rows, suffix.events.at(-1)?.seq ?? -1)) {
        base = SessionLogOffset(0)
        continue
      }
      const page = tailPageBoundary(suffix.events, maxMessages)
      if ((page.complete && page.cut >= base) || base === 0) {
        let restored: ReturnType<typeof registry.restore>
        try {
          restored = registry.restore(rows, suffix.events, suffix.fromSeq, suffix.meta, suffix.inheritedEventCount)
        } catch (error: unknown) {
          // Stale and future rows are disposable, but discarding one is only
          // sound over the complete log, so restore refuses above seq 0. Read
          // everything and refold; at seq 0 the row is dropped for init.
          if (base > 0) { base = SessionLogOffset(0); continue }
          throw error
        }
        // Await write-back before publishing the observation. It is fail-soft
        // but guarantees a successful first-frame-only read heals the cache.
        if (loaded.events.length === loaded.persistedEventCount) {
          await cache.writeBack(suffix.meta, suffix.inheritedEventCount, restored.checkpoint, rows)
          throwIfObservationAborted(signal)
        }
        const events = suffix.events
        const cursor: SessionSeqCursor = events.at(-1)?.seq ?? -1
        let disposed = false
        return {
          source: 'cold', header: suffix.meta, events,
          inheritedEventCount: suffix.inheritedEventCount, cursor,
          revision: found.revision, projections: restored.snapshot,
          retain: () => {
            if (disposed) throw new Error(`session observation "${sessionId}" is disposed`)
            return this.coldLease(
              suffix.meta, events, suffix.inheritedEventCount, cursor, found.revision, restored.snapshot,
            )
          },
          [Symbol.dispose]: () => { disposed = true },
        }
      }
      base = SessionLogOffset(Math.max(0, base - width))
      width *= 2
    }
  }

  private coldLease(
    header: SessionHeader,
    events: readonly SessionEvent[],
    inheritedEventCount: SessionLogOffsetType,
    cursor: SessionSeqCursor,
    revision: SessionPersistenceRevision,
    projections: ProjectionSnapshot,
  ): SessionObservation {
    let disposed = false
    return {
      source: 'cold', header, events, inheritedEventCount, cursor, revision, projections,
      retain: () => { if (disposed) throw new Error(`session observation "${header.id}" is disposed`); return this.coldLease(header, events, inheritedEventCount, cursor, revision, projections) },
      [Symbol.dispose]: () => { disposed = true },
    }
  }

  private live(
    session: Session,
    projectionMode: NonNullable<SessionObservationOptions['projectionMode']>,
  ): SessionObservation {
    // The cut is the log length now. The log only appends, so the prefix
    // below `seq` is the same array whenever a consumer first reads `events`.
    const seq = session.seq
    let materialized: readonly SessionEvent[] | undefined
    const projections = projectionMode === 'none'
      ? undefined
      : this.ctx.get('sessionProjections')?.snapshot(session)
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'live',
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        get events() {
          materialized ??= session.snapshotEvents(SessionLogOffset(0), seq)
          return materialized
        },
        cursor: seq === 0 ? -1 : SessionSeq(seq - 1),
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${session.id}" is disposed`)
          return lease()
        },
        [Symbol.dispose]: () => { disposed = true },
      }
    }
    return lease()
  }

  private preparedProjections(entry: PreparedEntry): ProjectionSnapshot | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    const cache = this.ctx.get('sessionProjectionCache')
    return cache === undefined
      ? registry.hydrate(entry.session, {}, entry.events, SessionLogOffset(0))
      : cache.hydratePrepared(entry.session, entry.events)
  }
}

/** Whether any cached row claims a watermark past the supplied log end. */
function claimsBeyond(rows: ProjectionCheckpoint, endSeq: SessionSeqCursor): boolean {
  for (const row of Object.values(rows)) if (row.seq > endSeq) return true
  return false
}

function tailPageBoundary(events: readonly SessionEvent[], maxMessages: number): { complete: boolean; cut: SessionLogOffsetType } {
  let count = 0
  let cut = SessionLogOffset(0)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent
    if (!isAppendSurfaceEvent(event) || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue
    count++
    let groupStart = event.seq
    for (const source of event.sourceEventSeqs ?? []) if (source < groupStart) groupStart = source
    if (count >= maxMessages) { cut = SessionLogOffset(groupStart); return { complete: true, cut } }
  }
  return { complete: false, cut }
}

function throwIfObservationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw new SessionQueryError(
    'session observation was aborted',
    'SESSION_QUERY_ABORTED',
    { cause: signal.reason },
  )
}

function mapPersistenceFailure(sessionId: SessionId, error: unknown): SessionQueryError {
  if (hasErrorName(error, 'SessionPersistenceNotFoundError')) return notFound(sessionId, error)
  if (hasErrorName(error, 'SessionPersistenceCorruptionError')) {
    return new SessionQueryError(
      `stored session "${sessionId}" is corrupt: ${error.message}`,
      'SESSION_QUERY_CORRUPT_SESSION',
      { cause: error },
    )
  }
  return new SessionQueryError(
    `failed to observe session "${sessionId}": ${errorMessage(error)}`,
    'SESSION_QUERY_PERSISTENCE_FAILED',
    { cause: error },
  )
}

function notFound(sessionId: SessionId, cause?: unknown): SessionQueryError {
  return new SessionQueryError(
    `session "${sessionId}" not found`,
    'SESSION_QUERY_SESSION_NOT_FOUND',
    cause === undefined ? undefined : { cause },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name
}
