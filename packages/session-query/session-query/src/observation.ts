/** Shared live/prepared observations for Session page and lifecycle consumers. */

import type { Context } from '@deepseek-ai/cordis'
import { isAppendSurfaceEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type {
  BorrowedSessionSource,
  SessionPersistence,
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionCheckpoint, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { SessionQueryError } from './config.ts'

/**
 * How many times a cold tail refolds when the durable revision moved under it.
 * A log that keeps moving declines to the borrow path rather than publishing a
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
  /** Complete preparation/promotion deferred until after a cold first frame. */
  readonly activate?: () => Promise<void>
  /** Immutable Session identity metadata. */
  readonly header: SessionHeader
  /** Immutable contiguous events at {@link cursor}. */
  readonly events: readonly SessionEvent[]
  /** Exact number of fork-inherited events in this Session lifecycle. */
  readonly inheritedEventCount: SessionLogOffsetType
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

/** Builds point observations without a corpus listing preflight. */
export class SessionObservationReader {
  /** @param ctx - context carrying Session and optional persistence/projection services. */
  constructor(private readonly ctx: Context) {}

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

      let borrowed: BorrowedSessionSource
      try {
        borrowed = await persistence.borrowSession(sessionId, signal)
      } catch (error: unknown) {
        throwIfObservationAborted(signal)
        if (hasErrorName(error, 'SessionPersistenceNotFoundError')) throw notFound(sessionId, error)
        if (hasErrorName(error, 'SessionPersistenceCorruptionError')) {
          throw new SessionQueryError(
            `stored session "${sessionId}" is corrupt: ${error.message}`,
            'SESSION_QUERY_CORRUPT_SESSION',
            { cause: error },
          )
        }
        throw new SessionQueryError(
          `failed to observe session "${sessionId}": ${errorMessage(error)}`,
          'SESSION_QUERY_PERSISTENCE_FAILED',
          { cause: error },
        )
      }

      try {
        throwIfObservationAborted(signal)
        if (borrowed.inspection.meta.id !== sessionId) {
          throw new SessionQueryError(
            `session persistence returned "${borrowed.inspection.meta.id}" for "${sessionId}"`,
            'SESSION_QUERY_SOURCE_CONFLICT',
          )
        }
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined) {
          const liveObservation = this.live(attached, projectionMode)
          borrowed[Symbol.dispose]()
          return liveObservation
        }
        if (borrowed.source === 'live') {
          // The live Session disappeared between persistence's race check and
          // this read. Retry against its now-cold durable identity.
          borrowed[Symbol.dispose]()
          continue
        }
        const prepared = borrowed
        const events = prepared.inspection.events
        let projections: ProjectionSnapshot | undefined
        try {
          projections = projectionMode === 'none'
            ? undefined
            : this.preparedProjections(prepared, events)
        } catch (error: unknown) {
          throw new SessionQueryError(
            `failed to project session "${sessionId}": ${errorMessage(error)}`,
            'SESSION_QUERY_CORRUPT_SESSION',
            { cause: error },
          )
        }
        let references = 1
        const lease = (): SessionObservation => {
          let disposed = false
          return {
            source: 'prepared',
            header: prepared.inspection.meta,
            events,
            inheritedEventCount: prepared.inspection.inheritedEventCount,
            cursor: events.at(-1)?.seq ?? -1,
            revision: prepared.revision,
            ...projections === undefined ? {} : { projections },
            retain: () => {
              if (disposed || references === 0) throw new Error(`session observation "${sessionId}" is disposed`)
              references += 1
              return lease()
            },
            [Symbol.dispose]: () => {
              if (disposed) return
              disposed = true
              references -= 1
              if (references === 0) prepared[Symbol.dispose]()
            },
          }
        }
        return lease()
      } catch (error: unknown) {
        borrowed[Symbol.dispose]()
        throw error
      }
    }
  }

  /**
   * Open one detached history tail from the durable snapshot, the projection
   * cache, and a suffix read, or decline so the caller falls back to the
   * always-correct borrow path.
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
    if (typeof persistence.readFrom !== 'function') return undefined
    try {
      return await this.coldAttempts({ persistence, registry, cache }, sessionId, maxMessages, signal)
    } catch (error: unknown) {
      // A backend that rejects because the caller cancelled must read as
      // cancellation here, exactly as a cancelled borrow does.
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
   * @returns the cold observation, or undefined to fall back to the borrow path.
   */
  private async coldAttempts(
    services: ColdTailServices,
    sessionId: SessionId,
    maxMessages: number,
    signal: AbortSignal | undefined,
  ): Promise<SessionObservation | undefined> {
    const { persistence } = services
    for (let attempt = 0; attempt < COLD_TAIL_REVISION_ATTEMPTS; attempt += 1) {
      const found = await pointSnapshot(persistence, sessionId, signal)
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
      const current = await pointSnapshot(persistence, sessionId, signal)
      throwIfObservationAborted(signal)
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
    let rows: ProjectionCheckpoint = cache.checkpointFor(found.header, SessionLogOffset(0)) ?? {}
    const restoreFloor = registry.restoreFloor(rows)
    if (restoreFloor === undefined) return undefined

    // A projection restore floor is not a history-page floor. Widen the read
    // until the complete append-surface message group at the page boundary is
    // present; otherwise paginate() would report a false short page/hasMore.
    let base = restoreFloor
    let width = Math.max(8, maxMessages * 4)
    for (;;) {
      throwIfObservationAborted(signal)
      const suffix = await persistence.readFrom(sessionId, base, signal)
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
        if (typeof cache.writeBack === 'function') {
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
    const events = session.snapshotEvents()
    const projections = projectionMode === 'none'
      ? undefined
      : this.ctx.get('sessionProjections')?.snapshot(session)
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'live',
        header: session.header,
        events,
        inheritedEventCount: session.inheritedEventCount,
        cursor: events.at(-1)?.seq ?? -1,
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

  private preparedProjections(
    observation: Extract<BorrowedSessionSource, { readonly source: 'prepared' }>,
    events: readonly SessionEvent[],
  ): ProjectionSnapshot | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    const prepared = observation.preparedSession
    const cache = this.ctx.get('sessionProjectionCache')
    return cache === undefined
      ? registry.hydrate(prepared, {}, events, SessionLogOffset(0))
      : cache.hydratePrepared(prepared, events)
  }
}

/**
 * Read one durable snapshot for a single session without a corpus listing when
 * the backend offers a point lookup.
 * @param persistence - the mounted persistence service.
 * @param sessionId - the session to look up.
 * @param signal - optional cancellation for the lookup.
 * @returns the header and revision, or undefined when nothing is stored.
 */
async function pointSnapshot(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal: AbortSignal | undefined,
): Promise<SessionPersistenceSnapshot | undefined> {
  if (typeof persistence.snapshot === 'function') return persistence.snapshot(sessionId, signal)
  if (typeof persistence.listSnapshots !== 'function') return undefined
  const listed = await persistence.listSnapshots(signal)
  return listed.find(item => item.header.id === sessionId)
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
