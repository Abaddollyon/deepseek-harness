import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { BorrowedSessionSource } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'

function header(id: string): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 1, cwd: '/workspace', isSeeded: false }
}

function preparedSource(
  meta: SessionHeader,
  dispose = vi.fn(),
): BorrowedSessionSource {
  const preparedSession = Session.create(meta.id, [], meta, SessionLogOffset(0))
  return {
    source: 'prepared',
    inspection: {
      meta: preparedSession.header,
      inheritedEventCount: preparedSession.inheritedEventCount,
      events: preparedSession.snapshotEvents(),
    },
    revision: SessionPersistenceRevision(`fixture:${meta.id}`),
    preparedSession,
    [Symbol.dispose]: dispose,
  }
}

describe('SessionObservationReader', () => {
  it('prefers a live Session that attaches while a prepared source is borrowed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('attached-during-borrow')
    const dispose = vi.fn()
    const prepared = preparedSource(meta, dispose)
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        ctx.sessions.create(meta.id, { meta })
        return Promise.resolve(prepared)
      },
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('live')
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('releases a borrowed source once when the winning live projection fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('attached-projection-failure')
    const dispose = vi.fn()
    const prepared = preparedSource(meta, dispose)
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        ctx.sessions.create(meta.id, { meta })
        return Promise.resolve(prepared)
      },
    } as never)
    vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(() => {
      throw new Error('projection failed')
    })

    await expect(new SessionObservationReader(ctx).read(meta.id)).rejects.toThrow('projection failed')
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('retries when persistence reports a live source that has already detached', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('detached-live-source')
    const disposeLive = vi.fn()
    const prepared = preparedSource(meta)
    const borrowSession = vi.fn()
      .mockResolvedValueOnce({
        source: 'live',
        inspection: { meta, inheritedEventCount: SessionLogOffset(0), events: [] },
        [Symbol.dispose]: disposeLive,
      } satisfies BorrowedSessionSource)
      .mockResolvedValueOnce(prepared)
    ctx.provide('sessionPersistence', { borrowSession } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('prepared')
    expect(borrowSession).toHaveBeenCalledTimes(2)
    expect(disposeLive).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('returns a prepared observation without projections when no registry is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('prepared-without-projections')
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta)),
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id)

    expect(observed.source).toBe('prepared')
    expect(observed.projections).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reference-counts prepared leases and rejects retention after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('prepared-leases')
    const dispose = vi.fn()
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta, dispose)),
    } as never)
    const observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    observed[Symbol.dispose]()
    expect(dispose).not.toHaveBeenCalled()
    expect(() => observed.retain()).toThrow('is disposed')
    retained[Symbol.dispose]()
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('creates independent live leases and rejects retention after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('live-leases'), { meta: { cwd: '/workspace' } })
    const reader = new SessionObservationReader(ctx)
    const observed = await reader.read(session.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    expect(() => observed.retain()).toThrow('is disposed')
    expect(retained.source).toBe('live')
    retained[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('carries the exact inherited cut on a live observation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const inherited = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as const
    const session = ctx.sessions.create(SessionId('seeded-observation'), {
      seed: inherited,
      inheritedEventCount: SessionLogOffset(inherited.length),
      meta: { cwd: '/workspace', isSeeded: true },
    })

    using observed = await new SessionObservationReader(ctx).read(session.id, { projectionMode: 'none' })

    expect(observed.inheritedEventCount).toBe(SessionLogOffset(inherited.length))
    await ctx.fiber.dispose()
  })

  it.each([
    ['missing suffix read', 'missing-readfrom'],
    ['missing point lookup', 'missing-listing'],
    ['missing snapshot', 'missing-snapshot'],
    ['seeded snapshot', 'seeded-snapshot'],
    ['missing restore floor', 'missing-floor'],
  ] as const)('falls back from a %s cold-tail prerequisite', async (_label, mode) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('cold-fallback-' + mode)
    const prepared = preparedSource(meta)
    const revision = SessionPersistenceRevision('cold-fallback')
    const listedHeader = mode === 'seeded-snapshot' ? { ...meta, isSeeded: true } : meta
    ctx.provide('sessionPersistence', {
      borrowSession: async () => prepared,
      // Each mode must remove EXACTLY its own prerequisite: a fake missing an
      // earlier one would fall back for the wrong reason and stop covering the
      // rung it names.
      ...(mode === 'missing-readfrom' ? {} : {
        readFrom: async () => ({
          fromSeq: SessionLogOffset(0), meta, inheritedEventCount: SessionLogOffset(0), events: [],
        }),
      }),
      ...(mode === 'missing-listing' ? {} : {
        listSnapshots: async () => mode === 'missing-snapshot' ? [] : [{ header: listedHeader, revision }],
      }),
    } as never)
    ctx.provide('sessionProjectionCache', {
      checkpointFor: () => ({}),
      hydratePrepared: () => ({ asOfSeq: -1, values: {} }),
    } as never)
    ctx.provide('sessionProjections', {
      restoreFloor: () => mode === 'missing-floor' ? undefined : SessionLogOffset(0),
    } as never)

    using observation = await new SessionObservationReader(ctx).read(meta.id, { historyTail: true })
    expect(observation.source).toBe('prepared')
    await ctx.fiber.dispose()
  })

  it('owns independent cold-tail leases and rejects retaining disposed leases', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('cold-leases')
    const revision = SessionPersistenceRevision('cold-leases')
    const snapshot = { asOfSeq: -1, values: {} }
    ctx.provide('sessionPersistence', {
      listSnapshots: async () => [{ header: meta, revision }],
      readFrom: async () => ({
        fromSeq: SessionLogOffset(0), meta, inheritedEventCount: SessionLogOffset(0), events: [],
      }),
    } as never)
    ctx.provide('sessionProjectionCache', { checkpointFor: () => ({}) } as never)
    ctx.provide('sessionProjections', {
      restoreFloor: () => SessionLogOffset(0),
      restore: () => ({ snapshot }),
    } as never)

    const observation = await new SessionObservationReader(ctx).read(meta.id, { historyTail: true })
    expect(observation).toMatchObject({ source: 'cold', cursor: -1, projections: snapshot })
    const retained = observation.retain()
    const nested = retained.retain()
    retained[Symbol.dispose]()
    expect(() => retained.retain()).toThrow(/disposed/)
    nested[Symbol.dispose]()
    observation[Symbol.dispose]()
    expect(() => observation.retain()).toThrow(/disposed/)
    await ctx.fiber.dispose()
  })

  it('contains a non-Error persistence rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sessionPersistence', {
      // Exercise containment of a backend that violates the Error rejection convention.
      borrowSession: () => Promise.reject('offline'),
    } as never)

    await expect(new SessionObservationReader(ctx).read(SessionId('failed'))).rejects.toMatchObject({
      code: 'SESSION_QUERY_PERSISTENCE_FAILED',
      message: expect.stringContaining('unknown error') as string,
    })
    await ctx.fiber.dispose()
  })
})
/** One append-surface user message, optionally grouped with earlier source events. */
function message(seq: number, sourceEventSeqs?: readonly number[]): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: { content: [{ type: 'text', text: `m${seq}` }], source: { kind: 'user' } },
    surfaceOp: 'append',
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs: sourceEventSeqs.map(SessionSeq) }),
  } as unknown as SessionEvent
}

/** One non-message event, which never counts toward a history page. */
function filler(seq: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq + 1, data: { turn: seq } } as unknown as SessionEvent
}

/** One cached checkpoint row for the single-unit registry double below. */
function rowsAt(seq: number): ProjectionCheckpoint {
  return { 'test/unit': { ver: 1, seq: SessionSeq(seq), val: null } }
}

/**
 * The registry contract the cold fold depends on, reproduced exactly: the
 * restore floor is one below the lowest usable watermark, and restore refuses
 * to discard an unusable row above seq 0.
 */
function fakeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    restoreFloor: (rows: ProjectionCheckpoint) => {
      const row = rows['test/unit']
      return SessionLogOffset(row === undefined ? 0 : Math.max(row.seq, 0))
    },
    restore: (_rows: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: number) => ({
      snapshot: { asOfSeq: events.at(-1)?.seq ?? baseSeq - 1, values: {} },
      checkpoint: rowsAt(events.at(-1)?.seq ?? baseSeq - 1),
    }),
    ...overrides,
  }
}

describe('SessionObservationReader: cold history tail', () => {
  /** Wire the three cold-tail services over one immutable stored log. */
  async function coldContext(options: {
    readonly meta: SessionHeader
    readonly log: readonly SessionEvent[]
    readonly rows?: ProjectionCheckpoint
    readonly suffixMeta?: SessionHeader
    readonly registry?: Record<string, unknown>
    readonly cache?: Record<string, unknown>
    readonly persistence?: Record<string, unknown>
    readonly revisions?: readonly (string | undefined)[]
  }): Promise<{
    ctx: Context
    bases: number[]
    snapshot: ReturnType<typeof vi.fn>
    listSnapshots: ReturnType<typeof vi.fn>
    writeBack: ReturnType<typeof vi.fn>
    restore: ReturnType<typeof vi.fn>
  }> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const { meta, log } = options
    const suffixMeta = options.suffixMeta ?? meta
    const bases: number[] = []
    let revisionIndex = 0
    const snapshot = vi.fn(async () => {
      const revisions = options.revisions ?? ['cold-revision']
      const value = revisions[Math.min(revisionIndex, revisions.length - 1)]
      revisionIndex += 1
      return value === undefined
        ? undefined
        : { header: meta, revision: SessionPersistenceRevision(value) }
    })
    const listSnapshots = vi.fn(async () => [{ header: meta, revision: SessionPersistenceRevision('listed') }])
    const readFrom = vi.fn(async (_id: SessionId, fromSeq: number) => {
      bases.push(fromSeq)
      return {
        fromSeq: SessionLogOffset(fromSeq),
        meta: suffixMeta,
        inheritedEventCount: SessionLogOffset(0),
        events: log.filter(event => event.seq >= fromSeq),
      }
    })
    ctx.provide('sessionPersistence', {
      snapshot, listSnapshots, readFrom,
      borrowSession: async () => preparedSource(meta),
      ...options.persistence,
    } as never)
    const writeBack = vi.fn(async () => {})
    ctx.provide('sessionProjectionCache', {
      // Rows are bound to ONE lifecycle: only the header they were folded from
      // may read them back.
      checkpointFor: (header: SessionHeader) => header.createdAt === meta.createdAt
        ? options.rows ?? {}
        : undefined,
      hydratePrepared: () => ({ asOfSeq: -1, values: {} }),
      writeBack,
      ...options.cache,
    } as never)
    const base = fakeRegistry(options.registry)
    const restore = vi.fn(base.restore as never)
    ctx.provide('sessionProjections', { ...base, restore } as never)
    return { ctx, bases, snapshot, listSnapshots, writeBack, restore }
  }

  const messageLog = (count: number): SessionEvent[] =>
    Array.from({ length: count }, (_unused, seq) => message(seq))

  it('widens the anchored read one step at a time instead of jumping to seq 0', async () => {
    const meta = header('cold-widening')
    const { ctx, bases } = await coldContext({ meta, log: messageLog(40), rows: rowsAt(38) })

    using observation = await new SessionObservationReader(ctx).read(meta.id, {
      historyTail: true, maxMessages: 4,
    })

    // 38 holds two messages, so the page is short; one 16-wide step (max(8, 4*4))
    // reaches 22, which contains the whole four-message page.
    expect(bases).toEqual([38, 22])
    expect(observation.source).toBe('cold')
    expect(observation.events.at(0)?.seq).toBe(22)
    await ctx.fiber.dispose()
  })

  it('keeps widening across a message group whose sources precede the anchor', async () => {
    const meta = header('cold-group-widening')
    const log = [...messageLog(30), filler(30), message(31, [30])]
    const { ctx, bases } = await coldContext({ meta, log, rows: rowsAt(31) })

    using observation = await new SessionObservationReader(ctx).read(meta.id, {
      historyTail: true, maxMessages: 1,
    })

    // The single-message page starts at its source event 30, which the anchored
    // read at 31 does not contain, so the read must widen before folding.
    expect(bases).toEqual([31, 23])
    expect(observation.events.at(0)?.seq).toBe(23)
    await ctx.fiber.dispose()
  })

  it('never lists the corpus when the backend serves a point lookup', async () => {
    const meta = header('cold-point-lookup')
    const { ctx, snapshot, listSnapshots } = await coldContext({ meta, log: messageLog(4) })

    using observation = await new SessionObservationReader(ctx).read(meta.id, { historyTail: true })

    expect(observation.source).toBe('cold')
    expect(listSnapshots).not.toHaveBeenCalled()
    // Once to anchor the fold, once to prove the revision did not move under it.
    expect(snapshot).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('discards cached rows bound to a lifecycle the suffix no longer names', async () => {
    const meta = header('cold-replaced')
    const replaced: SessionHeader = { ...meta, createdAt: meta.createdAt + 1 }
    const { ctx, bases, restore } = await coldContext({
      meta, suffixMeta: replaced, log: messageLog(6), rows: rowsAt(4),
    })

    using observation = await new SessionObservationReader(ctx).read(meta.id, { historyTail: true })

    // The rows matched the pre-replacement header, so the anchored read starts
    // at 4; the suffix names another lifecycle, so those rows are dropped and
    // the fold restarts from the complete log with no seed at all.
    expect(bases).toEqual([4, 0])
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledWith({}, expect.anything(), SessionLogOffset(0), replaced, SessionLogOffset(0))
    expect(observation.header).toEqual(replaced)
    await ctx.fiber.dispose()
  })

  it('reads the complete log in one extra step when a row claims events past the log end', async () => {
    const meta = header('cold-future-row')
    const { ctx, bases } = await coldContext({ meta, log: messageLog(6), rows: rowsAt(999) })

    using observation = await new SessionObservationReader(ctx).read(meta.id, { historyTail: true })

    // A doubling ladder from 999 would re-read the whole artifact many times.
    expect(bases).toEqual([999, 0])
    expect(observation.cursor).toBe(5)
    await ctx.fiber.dispose()
  })

  it('refolds from the complete log when restore refuses an anchored row', async () => {
    const meta = header('cold-stale-row')
    const { ctx, bases } = await coldContext({
      meta,
      log: messageLog(10),
      rows: rowsAt(3),
      registry: {
        restore: (_rows: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: number) => {
          if (baseSeq > 0) throw new Error('its checkpoint row is missing, version-mismatched, or beyond the supplied log end')
          return { snapshot: { asOfSeq: events.at(-1)?.seq ?? -1, values: {} }, checkpoint: rowsAt(events.at(-1)?.seq ?? -1) }
        },
      },
    })

    using observation = await new SessionObservationReader(ctx).read(meta.id, {
      historyTail: true, maxMessages: 1,
    })

    expect(bases).toEqual([3, 0])
    expect(observation.projections?.asOfSeq).toBe(9)
    await ctx.fiber.dispose()
  })

  it('surfaces a restore failure that the complete log cannot repair', async () => {
    const meta = header('cold-unrepairable')
    const { ctx } = await coldContext({
      meta,
      log: messageLog(4),
      registry: { restore: () => { throw new Error('cannot restore across missing seq 2') } },
    })

    await expect(new SessionObservationReader(ctx).read(meta.id, { historyTail: true }))
      .rejects.toThrow('cannot restore across missing seq 2')
    await ctx.fiber.dispose()
  })

  it('awaits the cache write-back, with the exact rows it restored from, before publishing', async () => {
    const meta = header('cold-writeback')
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writeBack = vi.fn(async () => { await gate })
    const { ctx } = await coldContext({
      meta, log: messageLog(4), rows: rowsAt(2), cache: { writeBack },
    })

    let settled = false
    const reading = new SessionObservationReader(ctx).read(meta.id, { historyTail: true })
      .then((observation) => { settled = true; return observation })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(writeBack).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    release?.()
    using observation = await reading
    expect(settled).toBe(true)
    expect(writeBack).toHaveBeenCalledWith(meta, SessionLogOffset(0), rowsAt(3), rowsAt(2))
    expect(observation.source).toBe('cold')
    await ctx.fiber.dispose()
  })

  it.each([
    ['a revision that keeps moving', ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']],
    ['an artifact that disappeared', ['r1', undefined]],
  ] as const)('declines to the borrow path under %s', async (_label, revisions) => {
    const meta = header('cold-revision-churn')
    const { ctx } = await coldContext({ meta, log: messageLog(4), revisions: [...revisions] })
    using observation = await new SessionObservationReader(ctx).read(meta.id, { historyTail: true })

    expect(observation.source).toBe('prepared')
    await ctx.fiber.dispose()
  })

  it('declines a detached cut once a Session attaches during the cold read', async () => {
    const meta = header('cold-attached-during-read')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sessionPersistence', {
      snapshot: async () => ({ header: meta, revision: SessionPersistenceRevision('attached') }),
      readFrom: async (_id: SessionId, fromSeq: number) => {
        ctx.sessions.create(meta.id, { meta })
        return {
          fromSeq: SessionLogOffset(fromSeq), meta,
          inheritedEventCount: SessionLogOffset(0), events: messageLog(4),
        }
      },
      borrowSession: async () => preparedSource(meta),
    } as never)
    ctx.provide('sessionProjectionCache', { checkpointFor: () => ({}), writeBack: async () => {} } as never)
    ctx.provide('sessionProjections', { ...fakeRegistry(), snapshot: () => ({ asOfSeq: 3, values: {} }) } as never)

    using observation = await new SessionObservationReader(ctx).read(meta.id, { historyTail: true })

    expect(observation.source).toBe('live')
    await ctx.fiber.dispose()
  })

  it('treats a registry that stops anchoring mid-fold as an unanchored read', async () => {
    const meta = header('cold-floor-lost')
    const restoreFloor = vi.fn()
      .mockReturnValueOnce(SessionLogOffset(5))
      .mockReturnValue(undefined)
    const { ctx, bases } = await coldContext({
      meta, log: messageLog(8), rows: rowsAt(5), registry: { restoreFloor },
    })

    using observation = await new SessionObservationReader(ctx).read(meta.id, { historyTail: true })

    expect(bases).toEqual([5, 0])
    expect(observation.source).toBe('cold')
    await ctx.fiber.dispose()
  })

  it.each([
    ['during the suffix read', 'read'],
    ['during the cache write-back', 'write-back'],
  ] as const)('aborts a cold tail %s', async (_label, when) => {
    const meta = header('cold-abort-' + when)
    const abort = new AbortController()
    const { ctx } = await coldContext({
      meta,
      log: messageLog(4),
      ...(when === 'read'
        ? { persistence: { readFrom: async () => { abort.abort(); throw new Error('cancelled') } } }
        : { cache: { writeBack: async () => { abort.abort() } } }),
    })

    await expect(new SessionObservationReader(ctx).read(meta.id, {
      historyTail: true, signal: abort.signal,
    })).rejects.toMatchObject({ code: 'SESSION_QUERY_ABORTED' })
    await ctx.fiber.dispose()
  })
})
