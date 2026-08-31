/**
 * Process-local provider for the background-job capability seam
 * (`ctx.jobs`). It keeps every record in memory and hands out fresh
 * snapshots, never live state. With `persist: true` and a mounted
 * `ctx.jobStore`, ordinary records are mirrored in order and durable starts
 * await their initial write before producer work begins; without a store,
 * ordinary jobs behave like the pure in-memory registry.
 *
 * Registrations outlive producer and controller fibers. Agent or service
 * disposal cancels live work and awaits compliant producers; a throwing
 * teardown cancel force-fails only the record and reports a possible orphan,
 * and a producer that never releases is force-failed once `teardownGraceMs`
 * expires so shutdown cannot wedge.
 * @module @deepseek-ai/dsh-jobs-local
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'
import { MAX_TIMER_DELAY_MS, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { JobRegistry, JobId, JOB_ADOPTION_ACCOUNT_REJECTED_DETAIL, PROCESS_INCARNATION } from '@deepseek-ai/dsh-jobs'
import type {
  JobAdoptedListener, JobDoneListener, JobHooks, JobKind, JobOutcome, JobRead, JobResumeCandidate, JobResumePlan, JobResumer,
  JobSnapshot, JobStart, JobStatus, JobsChangedListener,
} from '@deepseek-ai/dsh-jobs'
import type { JobRecord, JobStore } from '@deepseek-ai/dsh-jobs-store-domain'

/** Timeout code that distinguishes a bounded wait from caller cancellation. */
export const TASK_WAIT_TIMEOUT = 'TASK_WAIT_TIMEOUT'

/** Default maximum number of active jobs in one exact-owner bucket. */
const DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER = 10

/** Honest terminal detail for a persisted record no resumer could adopt. */
const NOT_RESUMABLE_DETAIL = 'not resumable after host restart'

/** Terminal detail naming a resume adoption the durable store refused to record. */
const ADOPTION_NOT_DURABLE_DETAIL = 'resume adoption could not be recorded durably'

/** Terminal detail for an adoption whose durable session account was unavailable. */

/** Honest terminal detail for a producer that outlived the teardown grace. */
const TEARDOWN_GRACE_DETAIL = 'producer did not release within teardownGraceMs; work may be orphaned'

/** Configuration for the process-local job registry. */
export interface Config {
  /**
   * Maximum `running` plus `stopping` jobs per exact owner or in the shared unowned bucket;
   * omission defaults to 10.
   */
  maxConcurrentJobsPerOwner?: number
  /**
   * Mirror records to `ctx.jobStore` (default false). Explicit opt-in: a
   * mounted store with `persist: false` writes nothing. With `persist: true`
   * and no store mounted, records stay in-memory until a store appears — the
   * composition owns providing one.
   */
  persist?: boolean
  /**
   * Per-owner cap on retained terminal records (default 100). Excess REPORTED
   * terminal records are evicted FIFO; an unreported terminal record always
   * survives eviction pressure, because evicting it would lose the completion
   * notice the model never read. `0` retains no reported terminal records.
   */
  maxSettledJobs?: number
  /**
   * Milliseconds service teardown waits for producers to release before
   * force-failing their records with an orphan warning and continuing
   * (default 10000). Bounds `disposeAll` so a producer that never settles
   * cannot wedge process shutdown.
   */
  teardownGraceMs?: number
  /**
   * UTF-8 byte cap applied to a record's final output before it is persisted
   * (default 65536). Independent of the per-notice `outputLimitBytes`; the
   * in-memory output is never clipped.
   */
  maxPersistedOutputBytes?: number
}

/** The registry's mutable per-job record (never handed out — see {@link LocalJobRegistry.snapshot}). */
interface TrackedTask {
  id: JobId
  kind: JobKind
  label: string
  /** 1-based display ordinal within the owner bucket; process-local. */
  ordinal: number
  outputLimitBytes: number | undefined
  /** Exact lifecycle owner; undefined for unowned and restored records. */
  owner: Agent | undefined
  /** Session the record belongs to; survives the {@link owner} object across restarts. */
  ownerSession: SessionId | undefined
  cancel: (reason?: string) => void
  readOutput: (() => string) | undefined
  status: JobStatus
  detail: string | undefined
  output: string | undefined
  startedAt: number
  finishedAt: number | undefined
  reported: boolean
  /** Producer-owned re-start payload; undefined means not resumable. */
  resumeSpec: JsonValue | undefined
  /** Incarnation that owns the record; differs from the process fact only for restored records. */
  incarnation: string
  /** Restored non-terminal record still awaiting a {@link JobResumer} decision. */
  pendingResume: boolean
  /** Prior process incarnation when this record was adopted before reconciliation. */
  adoptedFromIncarnation: string | undefined
  /** Whether the first durable mirror has started. */
  persistenceStarted: boolean
  /** Serialized durable mirror writes, drained during service teardown. */
  persisted: Promise<void>
  /** Set after a rejected store write; the record degrades to in-memory only. */
  persistDegraded: boolean
  /** A durable prior-incarnation record owns this id and replaces this local failure on remount. */
  restoreOnStoreAdoption: boolean
  /** Resolves once the terminal snapshot is recorded and listeners notified. */
  settled: Promise<void>
  /** Resolver for {@link settled}, called by the first effective settlement. */
  markSettled: () => void
  /** Live waits; settlement with a waiter marks the job reported. */
  waiters: number
  /** Removable resolvers for live waits; timeout/abort unregister before the job settles. */
  waitResolvers: Set<() => void>
}

/** True for the three terminal {@link JobStatus} values. */
function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed'
}

/**
 * One scope's contributions: the job controllers attached from it and the
 * completion listeners registered there. Both tables are anonymous because a
 * contribution is identified by its own disposer, never by a name a second
 * registrant could shadow.
 */
class JobLayer implements ScopeLayer {
  readonly controllers = new AnonymousEntries<symbol>()
  readonly listeners = new AnonymousEntries<JobDoneListener>()
  readonly changed = new AnonymousEntries<JobsChangedListener>()
  readonly adopted = new AnonymousEntries<JobAdoptedListener>()

  isEmpty(): boolean {
    return this.controllers.isEmpty() && this.listeners.isEmpty() && this.changed.isEmpty() && this.adopted.isEmpty()
  }
}

/**
 * The in-memory `jobs` registry. See the Service Definition contract in
 * `@deepseek-ai/dsh-jobs` for the ownership, isolation, and lifecycle
 * semantics this implementation honors.
 */
export class LocalJobRegistry extends JobRegistry {
  static Config: z<Config> = z.object({
    maxConcurrentJobsPerOwner: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER),
    persist: z.boolean().default(false),
    maxSettledJobs: z.number()
      .step(1)
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(100),
    teardownGraceMs: z.number()
      .step(1)
      .min(1)
      .max(MAX_TIMER_DELAY_MS)
      .default(10_000),
    maxPersistedOutputBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(65_536),
  })

  /** Schemastery-defaulted active-job limit. */
  private readonly maxConcurrentJobsPerOwner: number
  /** Whether records mirror to `ctx.jobStore` when one is mounted. */
  private readonly persist: boolean
  /** Per-owner retained-terminal cap (reported records only are evictable). */
  private readonly maxSettledJobs: number
  /** Teardown wait bound before force-failing non-settling producers. */
  private readonly teardownGraceMs: number
  /** Byte cap for persisted final output. */
  private readonly maxPersistedOutputBytes: number
  private store = new Map<JobId, TrackedTask>()
  /** Durable deletions for evicted records that teardown can no longer find in {@link store}. */
  private readonly retiredPersistences = new Set<Promise<void>>()
  /**
   * Session-keyed owner index over {@link store}: every record files under
   * its `ownerSession` (or the shared `undefined` bucket), in registration
   * order. Replaces the linear scans in {@link activeTaskCount} and
   * {@link disposeOwned}, which persistence would otherwise turn O(records)
   * against retained settled history.
   */
  private byOwner = new Map<SessionId | undefined, Set<JobId>>()
  /** Per-owner-bucket display ordinal counters (1-based). */
  private ordinals = new Map<SessionId | undefined, number>()
  /** Registered per-kind resume handlers. */
  private resumers = new Map<JobKind, JobResumer>()
  /**
   * Surfaces and listeners layered by the scope that registered them, in the
   * tools-registry shape: a contribution files into its registering context's
   * scope, and a read unions the global layer with the reader's scope chain.
   *
   * The registry is one process-wide instance serving every composition, so a
   * flat table would answer a per-owner question process-wide: one preset's
   * job controls would hold `start()` open for an agent whose own composition
   * loads none, and one settlement would reach every preset's notice listener.
   * Layers make both reads owner-relative. Nothing derives a cache from a
   * layer, so change notification is a no-op.
   */
  private readonly layers = new ScopedLayers<JobLayer>(() => new JobLayer(), () => {})
  private listenersClosed = false
  /** Owner agents with attached scope cleanup, mapped to the exact disposer. */
  private ownerCleanups = new Map<Agent, () => Promise<void> | void>()
  /** Service context used by detached settlement continuations and teardown. */
  private readonly selfCtx: Context

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery validates and fills the defaults before constructing the service.
    const resolved = config as Required<Config>
    this.maxConcurrentJobsPerOwner = resolved.maxConcurrentJobsPerOwner
    this.persist = resolved.persist
    this.maxSettledJobs = resolved.maxSettledJobs
    this.teardownGraceMs = resolved.teardownGraceMs
    this.maxPersistedOutputBytes = resolved.maxPersistedOutputBytes
    this.selfCtx = ctx
    ctx.effect(() => () => this.disposeAll(), 'jobs teardown')
    if (this.persist) {
      // The store is optional and may mount after this registry: adopt it
      // whenever it appears (restoring its records and mirroring anything that
      // started first). Writes resolve the store lazily through the service
      // container, so an unmounted store simply stops the mirroring while the
      // registry's own teardown writes still reach a live one.
      ctx.inject(['jobStore'], (storeCtx) => { this.adoptStore(storeCtx.jobStore) })
    }
  }

  start(spec: JobStart): JobId {
    return this.startLocal(spec, true)
  }

  private startLocal(spec: JobStart, mirrorInitialRecord: boolean): JobId {
    if (!this.servesOwner(spec.owner)) {
      throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)')
    }
    if (spec.kind.length === 0) throw new Error('invalid job kind: expected a non-empty string')
    if (spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string')
    if (spec.outputLimitBytes !== undefined
      && (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)) {
      throw new Error(`invalid outputLimitBytes: expected a positive safe integer, got ${JSON.stringify(spec.outputLimitBytes)}`)
    }
    if (spec.idHint !== undefined && spec.idHint.length === 0) {
      throw new Error('invalid idHint: expected a non-empty string')
    }
    const ownerSession = spec.owner?.id ?? spec.durability?.recordSession
    if (spec.owner !== undefined && spec.durability?.recordSession !== undefined
      && spec.durability.recordSession !== spec.owner.id) {
      throw new Error(`durability.recordSession "${spec.durability.recordSession}" does not name the owner's session "${spec.owner.id}"`)
    }
    if (spec.owner !== undefined) this.ensureOwnerCleanup(spec.owner)

    const active = this.activeTaskCount(spec.owner)
    if (active >= this.maxConcurrentJobsPerOwner) {
      throw new Error(
        `background job limit reached for this owner (limit: ${this.maxConcurrentJobsPerOwner}); use job_kill to stop an unneeded job, wait for it to finish, then retry`,
      )
    }

    const id = JobId(`${spec.kind}-${spec.idHint ?? randomUUID()}`)
    // A minted uuid cannot collide; a producer-supplied idHint can, and a
    // second record under one durable id would corrupt the store.
    if (this.store.has(id)) {
      throw new Error(`job id ${id} is already registered (idHint collision)`)
    }

    const hooks = spec.run()
    // Null and absent resumeSpec both mean non-resumable; normalizing here
    // keeps `resumable` a single `!== undefined` check everywhere else.
    const resumeSpec = spec.durability?.resumeSpec ?? undefined
    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => { markSettled = resolve })
    const job: TrackedTask = {
      id,
      kind: spec.kind,
      label: spec.label,
      ordinal: this.nextOrdinal(ownerSession),
      outputLimitBytes: spec.outputLimitBytes,
      owner: spec.owner,
      ownerSession,
      cancel: hooks.cancel.bind(hooks),
      readOutput: hooks.readOutput?.bind(hooks),
      status: 'running',
      detail: undefined,
      output: undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      reported: false,
      resumeSpec,
      incarnation: PROCESS_INCARNATION,
      pendingResume: false,
      adoptedFromIncarnation: undefined,
      persistenceStarted: false,
      persisted: Promise.resolve(),
      persistDegraded: false,
      restoreOnStoreAdoption: false,
      settled,
      markSettled,
      waiters: 0,
      waitResolvers: new Set(),
    }
    this.insertRecord(job)

    this.wireDone(job, hooks)
    // Registration is complete and cannot fail from here, so the visible set
    // has genuinely changed.
    if (mirrorInitialRecord) this.mirrorRecord(job)
    this.notifyChanged(job.owner)
    return id
  }

  async startDurable(spec: JobStart): Promise<JobId> {
    if (!this.persist) {
      throw new Error('durable background jobs unavailable: jobs-local persist is disabled')
    }
    const durableStore = this.storeRef()
    if (durableStore === undefined) {
      throw new Error('durable background jobs unavailable: no ctx.jobStore is mounted')
    }
    if (spec.idHint !== undefined) {
      const stableId = JobId(`${spec.kind}-${spec.idHint}`)
      if (durableStore.get(stableId) !== undefined) {
        throw new Error(`job id ${stableId} is already persisted (idHint collision)`)
      }
    }

    const terminal = Promise.withResolvers<JobOutcome>()
    let producer: JobHooks | undefined
    const id = this.startLocal({
      ...spec,
      run: () => ({
        cancel: (): void => { terminal.resolve({ status: 'killed' }) },
        done: terminal.promise,
      }),
    }, false)
    const job = this.expect(id)
    try {
      job.persistenceStarted = true
      job.persisted = durableStore.put(this.toRecord(job))
      await job.persisted
    } catch (error: unknown) {
      job.persisted = Promise.resolve()
      this.settle(job, { status: 'failed', detail: `durable registration failed: ${String(error)}` })
      throw new Error(`durable background job registration failed: ${String(error)}`, { cause: error })
    }
    if (isTerminal(job.status)) return id

    try {
      producer = spec.run()
      job.cancel = producer.cancel.bind(producer)
      job.readOutput = producer.readOutput?.bind(producer)
      producer.done.then(terminal.resolve, terminal.reject)
    } catch (error: unknown) {
      terminal.resolve({ status: 'failed', detail: `producer start failed: ${String(error)}` })
      throw error
    }
    return id
  }

  list(caller?: Agent): JobSnapshot[] {
    const session = caller?.id
    return [...this.store.values()]
      .filter(job => job.ownerSession === undefined || job.ownerSession === session)
      .map(job => this.snapshot(job))
  }

  get(id: JobId, caller?: Agent): JobSnapshot {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    return this.snapshot(job)
  }

  read(id: JobId, caller?: Agent): JobRead {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    const text = job.readOutput !== undefined
      ? job.readOutput()
      : isTerminal(job.status) ? job.output ?? '' : ''
    this.markReported(job)
    return { text, snapshot: this.snapshot(job) }
  }

  kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished' {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    if (isTerminal(job.status)) {
      this.markReported(job)
      return 'already-finished'
    }
    // Cancel first so a throw leaves both lifecycle and notice state unchanged.
    job.cancel(reason)
    job.status = 'stopping'
    job.reported = true
    this.mirrorRecord(job)
    this.notifyChanged(job.owner)
    return 'requested'
  }

  async wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot> {
    const job = this.expect(id)
    this.assertAccess(job, caller)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid wait timeout: expected a positive number of milliseconds, got ${JSON.stringify(timeoutMs)}`)
    }
    if (!isTerminal(job.status)) {
      if (signal?.aborted) throw new Error('wait aborted')
      // Abort removes the waiter synchronously so same-tick settlement cannot
      // suppress a notice for a wait that will reject.
      job.waiters += 1
      let counted = true
      const uncount = (): void => {
        if (!counted) return
        counted = false
        job.waiters -= 1
      }
      try {
        // The scoped deadline distinguishes a successful wait timeout from
        // caller cancellation and clears its timer on every exit.
        using d = deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)
        await new Promise<void>((resolve, reject) => {
          const onSettled = (): void => {
            job.waitResolvers.delete(onSettled)
            d.signal.removeEventListener('abort', onAbort)
            resolve()
          }
          const onAbort = (): void => {
            job.waitResolvers.delete(onSettled)
            // A settled job cannot reach here: settlement releases every waiter
            // before it announces completion, and each released waiter detaches
            // this listener in the same synchronous span, so nothing that reacts
            // to a settlement can abort a wait the settlement already owed.
            if (timeoutOf(d.signal, TASK_WAIT_TIMEOUT) !== undefined) {
              resolve()
            } else {
              uncount()
              reject(new Error('wait aborted'))
            }
          }
          job.waitResolvers.add(onSettled)
          d.signal.addEventListener('abort', onAbort, { once: true })
        })
      } finally {
        uncount()
      }
    }
    this.markReported(job)
    return this.snapshot(job)
  }

  onJobDone(listener: JobDoneListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.listeners.append(listener),
      { label: 'jobs.onJobDone()' },
    )
  }

  onJobsChanged(listener: JobsChangedListener): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.changed.append(listener),
      { label: 'jobs.onJobsChanged()' },
    )
  }

  onJobAdopted(listener: JobAdoptedListener): () => void {
    const dispose = this.ctx.effect(() => this.layers.global.adopted.append(listener), 'jobs.onJobAdopted()')
    return () => { void dispose() }
  }

  registerResumer(kind: JobKind, resume: JobResumer): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.resumers.has(kind)) {
        throw new Error(`a resumer is already registered for job kind "${kind}"`)
      }
      this.resumers.set(kind, resume)
      // Replay records of this kind that a previous process incarnation left
      // non-terminal; records this process owns are live work, never replayed.
      for (const job of [...this.store.values()]) {
        if (job.pendingResume && job.kind === kind
          && job.incarnation !== PROCESS_INCARNATION && job.resumeSpec !== undefined) {
          this.tryResume(job, resume)
        }
      }
      return () => { this.resumers.delete(kind) }
    }, 'jobs.registerResumer()')
    // The effect's disposer may report async cleanup; the contract disposer is
    // fire-and-forget like every other registry registration.
    return () => { void dispose() }
  }

  attachController(name: string): () => void {
    // One token per call keeps duplicate labels independently disposable.
    const token = Symbol(name)
    return this.layers.effect(
      this.ctx,
      layer => layer.controllers.append(token),
      { label: 'jobs.attachController()' },
    )
  }

  /**
   * Whether an attached job controller can collect and stop work owned by
   * `owner`. The global layer holds every controller attached from an unscoped
   * context — a host composition's own controls — and therefore serves every
   * owner; a scoped controller serves exactly the agents composed under it.
   * @param owner - the job's owner, or undefined for unowned work.
   * @returns whether some reachable controller serves the owner.
   */
  private servesOwner(owner?: Agent): boolean {
    if (!this.layers.global.controllers.isEmpty()) return true
    return this.layers.chainLayers(owner === undefined ? undefined : scopeOf(owner.ctx))
      .some(layer => !layer.controllers.isEmpty())
  }

  /**
   * Count authoritative active records for one exact owner or the shared
   * unowned bucket. The owner index narrows candidates to the owner's session
   * bucket; the exact-instance filter preserves the pre-index semantics, where
   * a same-session replacement agent never inherits its predecessor's quota.
   */
  private activeTaskCount(owner: Agent | undefined): number {
    let count = 0
    for (const job of this.ownedCandidates(owner?.id)) {
      if (job.owner === owner && (job.status === 'running' || job.status === 'stopping')) count += 1
    }
    return count
  }

  /** Resolve one session bucket of the owner index to its live records. */
  private *ownedCandidates(session: SessionId | undefined): IterableIterator<TrackedTask> {
    const ids = this.byOwner.get(session)
    if (ids === undefined) return
    for (const id of ids) {
      const job = this.store.get(id)
      // The index is maintained on every insert and removal, so a dangling id
      // is an internal inconsistency worth failing loud on.
      if (job === undefined) throw new Error(`jobs: owner index references missing job ${id}`)
      yield job
    }
  }

  /** File one new record into the store and the owner index. */
  private insertRecord(job: TrackedTask): void {
    this.store.set(job.id, job)
    let bucket = this.byOwner.get(job.ownerSession)
    if (bucket === undefined) {
      bucket = new Set()
      this.byOwner.set(job.ownerSession, bucket)
    }
    bucket.add(job.id)
  }

  /** Drop one record from the store and the owner index. */
  private removeRecord(job: TrackedTask): void {
    this.store.delete(job.id)
    const bucket = this.byOwner.get(job.ownerSession)
    if (bucket !== undefined) {
      bucket.delete(job.id)
      if (bucket.size === 0) this.byOwner.delete(job.ownerSession)
    }
  }

  /**
   * Wire a producer's `done` promise into first-wins settlement. A rejection
   * is a producer contract violation, contained as a `failed` outcome so
   * cleanup and waiters cannot hang.
   */
  private wireDone(job: TrackedTask, hooks: JobHooks): void {
    void hooks.done.then(
      (outcome) => { this.settle(job, outcome) },
      (error: unknown) => {
        this.selfCtx.logger.warn(`jobs: job ${job.id} producer done promise rejected (producer contract violation): ${String(error)}`)
        this.settle(job, { status: 'failed', detail: String(error) })
      },
    )
  }

  /** Next 1-based display ordinal for one owner bucket. */
  private nextOrdinal(session: SessionId | undefined): number {
    const next = (this.ordinals.get(session) ?? 0) + 1
    this.ordinals.set(session, next)
    return next
  }

  /**
   * The completion listeners that own `owner`'s notices: the global layer's
   * first, then each scoped layer along the owner's chain. A listener outside
   * that chain belongs to another composition and must not deliver, or the
   * owner reads one notice per mounted preset.
   * @param owner - the settled job's owner, or undefined for unowned work.
   * @returns the listeners to notify, in registration order per layer.
   */
  private *listenersFor(owner?: Agent): IterableIterator<JobDoneListener> {
    yield* this.layers.global.listeners.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.listeners.values()
  }

  /** Look up a job or fail loud. */
  private expect(id: JobId): TrackedTask {
    const job = this.store.get(id)
    if (job === undefined) throw new Error(`unknown job ${id}`)
    return job
  }

  /**
   * The isolation fence: a job with an owning session is reachable only by
   * callers whose session id matches (`!== undefined` semantics — an unowned
   * job is open, and a no-agent caller can never match an owned one). Keyed
   * by session rather than the live `Agent` so restored records stay fenced
   * after a restart.
   */
  private assertAccess(job: TrackedTask, caller?: Agent): void {
    if (job.ownerSession !== undefined && job.ownerSession !== caller?.id) {
      throw new Error(`job ${job.id} belongs to another session`)
    }
  }

  /** Mark a terminal record reported and follow with the persistence and retention consequences. */
  private markReported(job: TrackedTask): void {
    if (!isTerminal(job.status) || job.reported) return
    job.reported = true
    this.mirrorRecord(job)
    this.evictSettled(job.ownerSession)
  }

  /** Project a fresh read-only snapshot from the mutable record. */
  private snapshot(job: TrackedTask): JobSnapshot {
    return {
      id: job.id,
      ordinal: job.ordinal,
      kind: job.kind,
      label: job.label,
      ...job.outputLimitBytes !== undefined ? { outputLimitBytes: job.outputLimitBytes } : {},
      ...job.ownerSession !== undefined ? { ownerSession: job.ownerSession } : {},
      status: job.status,
      resumable: job.resumeSpec !== undefined,
      incarnation: job.incarnation,
      ...job.detail !== undefined ? { detail: job.detail } : {},
      startedAt: job.startedAt,
      ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
      reported: job.reported,
    }
  }

  /**
   * The change observers that own `owner`'s updates, resolved exactly like
   * {@link listenersFor}: the global layer — a host composition's own carrier,
   * which serves every owner — then each scoped layer along the owner's chain.
   * An observer outside that chain belongs to another composition and would
   * otherwise be told about agents it does not compose.
   * @param owner - the owner whose visible set moved, or undefined for unowned work.
   * @returns the observers to notify, in registration order per layer.
   */
  private *changedFor(owner?: Agent): IterableIterator<JobsChangedListener> {
    yield* this.layers.global.changed.values()
    const scope = owner === undefined ? undefined : scopeOf(owner.ctx)
    for (const layer of this.layers.chainLayers(scope)) yield* layer.changed.values()
  }

  /**
   * Announce that one owner's visible set changed. Each listener is contained
   * so an observer cannot break a lifecycle commit that already happened.
   */
  private notifyChanged(owner: Agent | undefined): void {
    for (const listener of this.changedFor(owner)) {
      try {
        listener(owner)
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`jobs: onJobsChanged listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Record the first terminal outcome, release waiters, then announce
   * completion. First-wins preserves a teardown force-failure against late
   * producer settlement. Pending waits mark the job reported before listeners
   * run. Completion is announced last because a reporter may open a model turn
   * synchronously: every other observer of this settlement must already have
   * seen the committed record.
   */
  private settle(job: TrackedTask, outcome: JobOutcome): void {
    if (isTerminal(job.status)) return
    job.status = outcome.status
    job.detail = outcome.detail
    job.output = outcome.output
    job.finishedAt = Date.now()
    job.pendingResume = false
    if (job.waiters > 0) job.reported = true
    const snapshot = this.snapshot(job)
    const waitResolvers = [...job.waitResolvers]
    job.waitResolvers.clear()
    for (const resolveWait of waitResolvers) resolveWait()
    job.markSettled()
    this.mirrorRecord(job)
    this.notifyChanged(job.owner)
    this.evictSettled(job.ownerSession)
    if (this.listenersClosed) return
    for (const listener of this.listenersFor(job.owner)) {
      try {
        const returned = listener(snapshot, job.owner)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.selfCtx.logger.warn(`jobs: onJobDone listener rejected for ${job.id}: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`jobs: onJobDone listener threw for ${job.id}: ${String(error)}`)
      }
    }
  }

  /**
   * Enforce the per-owner retained-terminal cap for one bucket. Reported
   * terminal records beyond `maxSettledJobs` are dropped FIFO (registration
   * order); an unreported terminal record survives — evicting it would lose
   * the completion notice the model never read — so a bucket full of
   * unreported completions may legitimately exceed the cap.
   */
  private evictSettled(session: SessionId | undefined): void {
    const terminal = [...this.ownedCandidates(session)].filter(job => isTerminal(job.status))
    let excess = terminal.length - this.maxSettledJobs
    if (excess <= 0) return
    for (const job of terminal) {
      if (excess <= 0) break
      if (!job.reported) continue
      this.removeRecord(job)
      this.deletePersisted(job)
      excess -= 1
      // Removal is a visible-set change no per-job record carries.
      this.notifyChanged(job.owner)
    }
  }

  /**
   * Mirror one record to the durable store, fire-and-forget on the store's
   * write chain. A rejected (or throwing) write logs and degrades that record
   * to in-memory only — the registry's own state stays authoritative, in the
   * same containment shape tool-workflow's recorder uses for a failing
   * session append.
   */
  /** Queue one record mirror after every earlier write for the same job. */
  private mirrorRecord(job: TrackedTask): void {
    if (!job.persistenceStarted) {
      job.persistenceStarted = true
      job.persisted = this.persistRecord(job)
      return
    }
    job.persisted = job.persisted.then(() => this.persistRecord(job))
  }

  private async persistRecord(job: TrackedTask): Promise<void> {
    if (!this.persist || job.persistDegraded) return
    const store = this.storeRef()
    if (store === undefined) return
    const degrade = (error: unknown): void => {
      job.persistDegraded = true
      this.selfCtx.logger.warn(`jobs: disabled durable record for ${job.id} after store write failed: ${String(error)}`)
    }
    try {
      await store.put(this.toRecord(job))
    } catch (error: unknown) {
      degrade(error)
    }
  }

  /** Queue durable deletion after every earlier mirror and retain it through teardown. */
  private deletePersisted(job: TrackedTask): void {
    if (!this.persist || job.persistDegraded) return
    const store = this.storeRef()
    if (store === undefined) return
    const deletion = job.persisted.then(async () => {
      try {
        await store.delete(job.id)
      } catch (error: unknown) {
        this.selfCtx.logger.warn(`jobs: failed to evict durable record ${job.id}: ${String(error)}`)
      }
    })
    job.persisted = deletion
    this.retiredPersistences.add(deletion)
    void deletion.then(() => this.retiredPersistences.delete(deletion))
  }

  /** Project one mutable record onto the durable-store shape. */
  private toRecord(job: TrackedTask): JobRecord {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ownerSession: job.ownerSession ?? null,
      status: job.status,
      detail: job.detail ?? null,
      output: job.output === undefined ? null : this.clipPersistedOutput(job.output),
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      reported: job.reported,
      outputLimitBytes: job.outputLimitBytes ?? null,
      resumeSpec: job.resumeSpec ?? null,
      incarnation: job.incarnation,
      ...job.adoptedFromIncarnation === undefined ? {} : { adoptedFromIncarnation: job.adoptedFromIncarnation },
      schemaVersion: 1,
    }
  }

  /** Bound persisted final output to `maxPersistedOutputBytes` (tail retention). */
  private clipPersistedOutput(output: string): string {
    const retainer = new TextRetainer({ kind: 'tail', maxBytes: this.maxPersistedOutputBytes })
    retainer.push(output)
    return retainer.finish().text
  }

  /** The currently mounted durable store, or undefined while none is available. */
  private storeRef(): JobStore | undefined {
    return this.selfCtx.get('jobStore')
  }

  /**
   * Adopt a mounted durable store: restore its records, then mirror any
   * records registered before the store appeared (registration-time writes
   * for those were skipped because there was nothing to write to).
   */
  private adoptStore(store: JobStore): void {
    const durableIds = this.restoreRecords(store)
    for (const job of this.store.values()) {
      if (!durableIds.has(job.id)) this.mirrorRecord(job)
    }
  }

  /**
   * Rebuild in-memory records from the durable store. Terminal records are
   * restored as-is (their `reported` flag keeps notice gating correct across
   * the restart). A non-terminal record from a previous process incarnation
   * either honest-settles now (`resumeSpec` null — nothing can adopt it) or
   * waits for its kind's {@link JobResumer}; a non-terminal record from THIS
   * incarnation is left untouched, because an in-process registry reload must
   * not mistake live work for orphans. Restored records carry their session
   * fence but no live `Agent`, so changes announce through the global lane.
   */
  private restoreRecords(store: JobStore): Set<JobId> {
    const stored = store.list()
    const durableIds = new Set(stored.map(record => record.id))
    const records = stored
      .filter((record) => {
        const existing = this.store.get(record.id)
        if (existing === undefined) return true
        if (!existing.restoreOnStoreAdoption) return false
        this.removeRecord(existing)
        return true
      })
      .sort((left, right) => left.startedAt - right.startedAt || String(left.id).localeCompare(String(right.id)))
    if (records.length === 0) return durableIds
    for (const record of records) {
      const job = this.restoredTask(record)
      this.insertRecord(job)
      if (isTerminal(job.status)) {
        job.markSettled()
        continue
      }
      if (job.incarnation === PROCESS_INCARNATION) continue
      if (job.status === 'stopping') {
        this.settle(job, { status: 'killed', detail: 'cancelled before host restart' })
        continue
      }
      if (job.resumeSpec === undefined) {
        this.settle(job, { status: 'failed', detail: NOT_RESUMABLE_DETAIL })
        continue
      }
      const resume = this.resumers.get(job.kind)
      if (resume !== undefined) this.tryResume(job, resume)
    }
    this.notifyChanged(undefined)
    return durableIds
  }

  /** Build the in-memory task for one persisted record. */
  private restoredTask(record: JobRecord): TrackedTask {
    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => { markSettled = resolve })
    const job: TrackedTask = {
      id: record.id,
      // The durable boundary stores kinds as plain strings; the merge-extensible
      // union cannot be checked at runtime, and the registry treats every kind
      // as an opaque namespace anyway.
      kind: record.kind as JobKind,
      label: record.label,
      ordinal: this.nextOrdinal(record.ownerSession ?? undefined),
      outputLimitBytes: record.outputLimitBytes ?? undefined,
      owner: undefined,
      ownerSession: record.ownerSession ?? undefined,
      cancel: (reason) => {
        // No producer is attached yet: a kill of a pending-resume record can
        // only settle the record itself. Deferred a microtask so the caller's
        // stopping transition commits before the terminal one.
        queueMicrotask(() => { this.settle(job, { status: 'killed', detail: reason ?? 'killed before resume' }) })
      },
      readOutput: undefined,
      status: record.status,
      detail: record.detail ?? undefined,
      output: record.output ?? undefined,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? undefined,
      reported: record.reported,
      resumeSpec: record.resumeSpec ?? undefined,
      incarnation: record.incarnation,
      pendingResume: !isTerminal(record.status),
      adoptedFromIncarnation: record.adoptedFromIncarnation,
      persistenceStarted: false,
      persisted: Promise.resolve(),
      persistDegraded: false,
      restoreOnStoreAdoption: false,
      settled,
      markSettled,
      waiters: 0,
      waitResolvers: new Set(),
    }
    return job
  }

  /**
   * Offer one restored record to its kind's resumer. A deferred producer plan
   * accepts the record; `undefined` or a throwing handler settles it as failed.
   */
  private tryResume(job: TrackedTask, resume: JobResumer): void {
    const candidate: JobResumeCandidate = {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...job.ownerSession !== undefined ? { ownerSession: job.ownerSession } : {},
      resumeSpec: job.resumeSpec as JsonValue,
      startedAt: job.startedAt,
      priorIncarnation: job.incarnation,
    }
    let plan: JobResumePlan | undefined
    try {
      plan = resume(candidate)
    } catch (error: unknown) {
      this.selfCtx.logger.warn(`jobs: resumer for kind "${job.kind}" threw for ${job.id}: ${String(error)}`)
      this.settle(job, { status: 'failed', detail: `resume handler threw: ${String(error)}` })
      return
    }
    if (plan === undefined) {
      this.settle(job, { status: 'failed', detail: NOT_RESUMABLE_DETAIL })
      return
    }
    job.pendingResume = false
    void this.adoptCandidate(job, candidate, plan)
  }

  /**
   * Adopt one restored record whose resumer returned a deferred producer. The
   * adoption marker and observer account commit before producer work starts.
   * The durable marker is required — unlike the fire-and-forget
   * {@link persistRecord} mirror, a store that rejects the re-stamped record
   * cancels the adoption into an honest resume failure, so no adopted job
   * ever runs unmarked under this incarnation.
   */
  private async adoptCandidate(job: TrackedTask, candidate: JobResumeCandidate, plan: JobResumePlan): Promise<void> {
    const priorMarker = job.adoptedFromIncarnation
    const accountIncarnation = priorMarker ?? candidate.priorIncarnation
    job.adoptedFromIncarnation = accountIncarnation
    job.incarnation = PROCESS_INCARNATION
    if (!await this.commitAdoptionMarker(job)) {
      job.adoptedFromIncarnation = priorMarker
      job.incarnation = candidate.priorIncarnation
      // The prior durable record remains authoritative. Keep this local failure
      // from overwriting it, then replace the failure if that store remounts.
      job.persistDegraded = true
      job.restoreOnStoreAdoption = true
      this.settle(job, { status: 'failed', detail: ADOPTION_NOT_DURABLE_DETAIL })
      return
    }
    try {
      await this.notifyAdopted(this.snapshot(job), accountIncarnation)
    } catch {
      this.settle(job, { status: 'failed', detail: JOB_ADOPTION_ACCOUNT_REJECTED_DETAIL })
      return
    }
    if (isTerminal(job.status)) {
      // A kill landed while the marker and its account committed; producer
      // work has not started and must remain unstarted.
      return
    }
    let hooks: JobHooks
    try {
      hooks = plan.start()
    } catch (error: unknown) {
      this.selfCtx.logger.warn(`jobs: resume producer for kind "${job.kind}" threw for ${job.id}: ${String(error)}`)
      this.settle(job, { status: 'failed', detail: `resume producer threw: ${String(error)}` })
      return
    }
    job.cancel = hooks.cancel.bind(hooks)
    job.readOutput = hooks.readOutput?.bind(hooks)
    this.wireDone(job, hooks)
    this.notifyChanged(job.owner)
  }

  /**
   * Commit the re-stamped record carrying the adoption marker. The put is
   * awaited and its failure reported, because the marker is the only proof a
   * later boot can account the adoption from. There are no unmarked
   * adoptions: a store that is already gone rejects the adoption exactly like
   * a failing put.
   */
  private async commitAdoptionMarker(job: TrackedTask): Promise<boolean> {
    const store = this.storeRef()
    if (store === undefined) return false
    try {
      await store.put(this.toRecord(job))
      return true
    } catch (error: unknown) {
      this.selfCtx.logger.warn(`jobs: adoption of ${job.id} is rejected: the durable marker could not be committed: ${String(error)}`)
      return false
    }
  }

  /**
   * Announce one committed adoption to the global host observers, awaiting
   * each returned promise so the supervisor's account lands before the
   * producer starts. Every observer runs; throws are logged after all settle,
   * while an explicit `false` rejects the adoption account.
   */
  private async notifyAdopted(snapshot: JobSnapshot, priorIncarnation: string): Promise<void> {
    const failures: unknown[] = []
    const pending: PromiseLike<void | boolean>[] = []
    let rejected = false
    for (const listener of this.layers.global.adopted.values()) {
      try {
        const result = listener(snapshot, priorIncarnation)
        if (result === false) rejected = true
        else if (result !== undefined && result !== true) pending.push(result)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    for (const outcome of await Promise.allSettled(pending)) {
      if (outcome.status === 'rejected') failures.push(outcome.reason)
      else if (outcome.value === false) rejected = true
    }
    for (const failure of failures) {
      this.selfCtx.logger.warn(`jobs: onJobAdopted listener failed: ${String(failure)}`)
    }
    if (rejected) throw new Error('job adoption observer rejected ownership')
  }

  /**
   * Attach one awaited cleanup through the exact owner's scope. This survives
   * producer reloads and joins agent quiescence; the retained disposer lets
   * service teardown detach the cross-fiber effect. Fails when the registry is
   * absent or the owner is not its currently registered instance.
   */
  private ensureOwnerCleanup(owner: Agent): void {
    const ownerId = owner.id
    const agents = this.selfCtx.get('agents')
    if (agents === undefined) {
      throw new Error('background job ownership requires the agent registry (load @deepseek-ai/dsh-agent)')
    }
    if (agents.get(ownerId) !== owner) {
      throw new Error(`agent "${ownerId}" is not the registered agent instance (background job owner must be live)`)
    }
    if (this.ownerCleanups.has(owner)) return
    // Record only after attach succeeds; a disposing scope rejects new effects.
    const detach = owner.ctx.effect(() => async () => {
      this.ownerCleanups.delete(owner)
      await this.disposeOwned(owner)
    }, 'jobs.ownerCleanup()')
    this.ownerCleanups.set(owner, detach)
  }

  /** Cancel, await terminal records, and drop every job owned by one exact agent lifecycle. */
  private async disposeOwned(owner: Agent): Promise<void> {
    const owned = [...this.ownedCandidates(owner.id)].filter(job => job.owner === owner)
    this.cancelForTeardown(owned, 'owner disposed')
    await Promise.all(owned.map(job => job.settled))
    for (const job of owned) this.removeRecord(job)
    // Removal is the one visible-set change no per-job record carries, so it
    // must be announced here or an observer keeps the dropped rows forever.
    if (owned.length > 0) this.notifyChanged(owner)
  }

  /**
   * Close listeners, cancel live jobs, await settlement within the teardown
   * grace, and detach owner effects. Throwing cancels are force-failed to
   * avoid teardown deadlock, and a producer still unsettled when
   * `teardownGraceMs` expires is force-failed with an orphan warning so
   * shutdown continues.
   */
  private async disposeAll(): Promise<void> {
    // The flag is the whole guard: each layer entry's undo belongs to the fiber
    // that registered it, so this service may not drop them on its own way out.
    this.listenersClosed = true
    const all = [...this.store.values()]
    this.cancelForTeardown(all, 'jobs service disposed')
    await this.settleWithinGrace(all)
    await this.persistWithinGrace(all)
    // Distinct owners whose records just disappeared. A change observer files
    // into the layer of the context that registered it, so a consumer mounted
    // outside this service — the api-proxy carrier registers from the mux
    // stream — is still reachable here. Without this it keeps the rows it last
    // received after a registry reload.
    const emptied = new Set(all.map(job => job.owner))
    this.store.clear()
    this.byOwner.clear()
    for (const owner of emptied) this.notifyChanged(owner)
    // Detach cross-fiber owner effects after the shared store is quiescent.
    const ownerCleanups = [...this.ownerCleanups.values()]
    this.ownerCleanups.clear()
    await Promise.all(ownerCleanups.map(cleanup => Promise.resolve(cleanup())))
  }

  /**
   * Await settlement of every record, bounded by `teardownGraceMs`. Past the
   * grace every still-live record is force-failed with the orphan-warning
   * detail — the honest account: cancellation was requested, the producer did
   * not release, and its work may still be running.
   */
  private async settleWithinGrace(jobs: TrackedTask[]): Promise<void> {
    const settledAll = Promise.all(jobs.map(job => job.settled))
    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<'grace'>((resolve) => {
      timer = setTimeout(() => { resolve('grace') }, this.teardownGraceMs)
      timer.unref()
    })
    const raced = await Promise.race([settledAll.then(() => 'settled' as const), grace])
    clearTimeout(timer)
    if (raced === 'grace') {
      for (const job of jobs) {
        if (isTerminal(job.status)) continue
        this.selfCtx.logger.warn(`jobs: producer of ${job.id} did not release within teardownGraceMs (${this.teardownGraceMs}ms); job record forced failed and work may be orphaned`)
        this.settle(job, { status: 'failed', detail: TEARDOWN_GRACE_DETAIL })
      }
    }
    await settledAll
  }

  /** Await queued durable mirrors without allowing a store to wedge teardown. */
  private async persistWithinGrace(jobs: TrackedTask[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<'grace'>((resolve) => {
      timer = setTimeout(() => { resolve('grace') }, this.teardownGraceMs)
      timer.unref()
    })
    const persisted = Promise.all([
      ...jobs.map(job => job.persisted),
      ...this.retiredPersistences,
    ])
    const raced = await Promise.race([persisted.then(() => 'persisted' as const), grace])
    clearTimeout(timer)
    if (raced === 'grace') {
      this.selfCtx.logger.warn(`jobs: durable mirrors did not settle within teardownGraceMs (${this.teardownGraceMs}ms); persisted state may require boot reconciliation`)
    }
  }

  /**
   * Cancel jobs during teardown with per-job containment. A throwing cancel
   * force-fails the record and reports a possible orphan; a cancel that returns
   * without settling remains indistinguishable from a slow stop until the
   * teardown grace expires.
   */
  private cancelForTeardown(jobs: TrackedTask[], reason: string): void {
    for (const job of jobs) {
      if (isTerminal(job.status)) continue
      // Teardown cancellation is a kill without a caller, so it claims the
      // terminal report the same way `kill()` does. Nothing will read a notice
      // for a job whose owner or service is being destroyed, and a waking
      // reporter would spend a model request per teardown layer. This is
      // decided before the producer runs: the force-failure below settles the
      // record too, so a throwing cancel must not be the one path that
      // announces an unreported completion into a disposing owner.
      job.reported = true
      try {
        job.cancel(reason)
        job.status = 'stopping'
        this.mirrorRecord(job)
        // Teardown reaches settlement only after the producer releases, which a
        // slow stop can defer; announcing the transition here is what keeps an
        // observer from showing `running` for that whole window.
        this.notifyChanged(job.owner)
      } catch (error: unknown) {
        const detail = `cancel threw during teardown; work may be orphaned: ${String(error)}`
        this.selfCtx.logger.warn(`jobs: cancel of ${job.id} threw during teardown; job record forced failed and work may be orphaned: ${String(error)}`)
        this.settle(job, { status: 'failed', detail })
      }
    }
  }
}

export default LocalJobRegistry
