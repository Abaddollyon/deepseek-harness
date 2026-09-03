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
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SessionQueryError } from './config.ts'

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

  private async coldTail(sessionId: SessionId, signal: AbortSignal | undefined, maxMessages: number): Promise<SessionObservation | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    const registry = this.ctx.get('sessionProjections')
    const cache = this.ctx.get('sessionProjectionCache')
    if (persistence === undefined || registry === undefined || cache === undefined) return undefined
    if (typeof persistence.readFrom !== 'function') return undefined
    const found = typeof persistence.snapshot === 'function'
      ? await persistence.snapshot(sessionId, signal)
      : (typeof persistence.listSnapshots === 'function'
        ? (await persistence.listSnapshots(signal)).find(item => item.header.id === sessionId)
        : undefined)
    if (found === undefined || found.header.isSeeded) return undefined
    const rows = cache.checkpointFor(found.header, SessionLogOffset(0)) ?? {}
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
      const page = tailPageBoundary(suffix.events, maxMessages)
      if ((page.complete && page.cut >= base) || base === 0) {
        let restored: ReturnType<typeof registry.restore>
        try {
          restored = registry.restore(rows, suffix.events, suffix.fromSeq, suffix.meta, suffix.inheritedEventCount)
        } catch (error: unknown) {
          // Stale/future rows are disposable. A non-zero anchored read cannot
          // safely discard one, so retry from the complete log.
          if (base !== 0) { base = SessionLogOffset(0); width = 1; continue }
          throw error
        }
        // Await write-back before publishing the observation. It is fail-soft
        // but guarantees a successful first-frame-only read heals the cache.
        if (typeof cache.writeBack === 'function') await cache.writeBack(suffix.meta, suffix.inheritedEventCount, restored.checkpoint)
        const events = suffix.events
        let disposed = false
        return {
          source: 'cold', header: suffix.meta, events,
          inheritedEventCount: suffix.inheritedEventCount, cursor: events.at(-1)?.seq ?? -1,
          revision: found.revision, projections: restored.snapshot,
          retain: () => {
            if (disposed) throw new Error(`session observation "${sessionId}" is disposed`)
            return this.coldLease(suffix.meta, events, suffix.inheritedEventCount, events.at(-1)?.seq ?? -1, found.revision, restored.snapshot)
          },
          [Symbol.dispose]: () => { disposed = true },
        }
      }
      if (base === 0) return undefined
      const next = Math.max(0, Number(base) - width)
      if (next === base) base = SessionLogOffset(0)
      else base = SessionLogOffset(next)
      width = Math.min(Number.MAX_SAFE_INTEGER, width * 2)
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
