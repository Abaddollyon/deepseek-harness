/**
 * The run supervisor: the host-plane boot-reconciliation consumer of the
 * durable job registry. When a `ctx.jobStore` is mounted, the registry
 * (`@deepseek-ai/dsh-jobs-local`) has already restored its records — terminal
 * ones as-is, prior-incarnation non-resumable ones honestly settled, and
 * prior-incarnation resumable ones left pending for a producer
 * `registerResumer` handler. This plugin owns everything the process-local
 * registry deliberately does not:
 *
 * - **Owner resolution.** Every restored record is grouped by
 *   `ownerSession` and its owner is resolved: a live agent
 *   (`ctx.agents.get`), else a restorable session
 *   (`ctx.sessionPersistence.prepare`), else an orphan.
 * - **Policy.** `resumeOnBoot`, the `maxResumedRunsPerOwner` per-owner
 *   adoption budget, and the `bootResumeTimeoutMs` pass deadline decide
 *   which pending records may still be adopted and which settle now.
 * - **The model-visible account.** `run/resumed` and `run/abandoned`
 *   session events are appended to the owner session when it is reachable
 *   (live session append, or a durable offline append through
 *   `sessionPersistence`), and an unreported terminal record produces
 *   exactly one completion notice for a live owner — none when the persisted
 *   `reported` flag says the model already collected it.
 * - **Orphan retention.** Terminal records whose owner session can neither
 *   be found live nor listed by persistence are evicted from the durable
 *   store once `orphanRetentionMs` has passed since they settled.
 *
 * Mount it in the host composition AFTER `jobs-local` and
 * `jobs-store-domain`: its reconciliation triggers when the store service
 * activates, and the registry's own store adoption (an earlier-registered
 * inject fiber) must have run first. The registry's public surface is the
 * only lane it uses — restored records stay fenced to their owning session,
 * so supervisor-driven settlement goes through `registerResumer` declines,
 * which preserve `reported` and the first-wins terminal record.
 *
 * @module @deepseek-ai/dsh-run-supervisor
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { PROCESS_INCARNATION } from '@deepseek-ai/dsh-jobs/incarnation'
import type { JobId, JobKind, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { JobRecord, JobStore } from '@deepseek-ai/dsh-jobs-store-domain'
import type { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'
// Loads the Context.sessionPersistence augmentation; the service itself is
// resolved optionally through ctx.get.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { RunAbandonedData, RunResumedData } from './types.ts'
import type {} from './types.ts'

export type { RunAbandonedData, RunDetachedData, RunResumedData } from './types.ts'

/** The structured reason a boot reconciliation abandoned a run. */
export type RunAbandonReason = 'not-resumable' | 'owner-unavailable' | 'reconcile-timeout' | 'resume-failed'

/**
 * Terminal detail naming a run that carried no usable resume path this boot:
 * no resume payload at all, a deployment that disabled boot resume, or a
 * per-owner adoption budget with no slot left.
 */
export const DETAIL_NOT_RESUMABLE = 'host restarted before this run settled; it is not resumable'

/** Terminal detail naming a run whose owning session could not be restored. */
export const DETAIL_OWNER_UNAVAILABLE = 'host restarted and the owning session could not be restored'

/** Terminal detail naming a run still unadopted when the reconciliation deadline passed. */
export const DETAIL_RECONCILE_TIMEOUT = 'boot reconciliation timed out'

/**
 * Terminal detail naming a resumable run the `maxResumedRunsPerOwner`
 * per-owner budget left no adoption slot for.
 */
export const DETAIL_RESUME_CAP = 'host restarted before this run settled; the per-owner resume cap (maxResumedRunsPerOwner) left no slot for it'

/**
 * The registry's own honest-settle detail
 * (`@deepseek-ai/dsh-jobs-local`), matched to recognize records a boot
 * restore or resumer decline already settled. The fenced public registry
 * surface admits no custom terminal detail, so supervisor-driven settlements
 * carry this detail on the RECORD; the precise reason lives in the
 * `run/abandoned` session event, which the design designates as the
 * model-visible account.
 */
export const REGISTRY_NOT_RESUMABLE_DETAIL = 'not resumable after host restart'

/** Detail prefix the registry writes when a resumer throws. */
export const REGISTRY_RESUME_THREW_PREFIX = 'resume handler threw: '

/** Configuration for the run supervisor. */
export interface Config {
  /**
   * Resume restorable runs at boot (default true). `false` honest-settles
   * every pending prior-incarnation record: a deployment may prefer a clean
   * boot over adoption.
   */
  resumeOnBoot?: boolean
  /**
   * Milliseconds the whole reconciliation pass may take before every still
   * pending record honest-settles with `'boot reconciliation timed out'`
   * (default 30000). Bounds owner restoration and the wait for producer
   * resumers to register.
   */
  bootResumeTimeoutMs?: number
  /**
   * Maximum prior-incarnation runs one owner session may have adopted at
   * boot (default 10); the overflow honest-settles so a restart cannot
   * stampede past the registry's per-owner concurrency limit.
   */
  maxResumedRunsPerOwner?: number
  /**
   * Milliseconds an honest-settled record whose owner session can be neither
   * found live nor listed by persistence stays in the durable store before
   * boot reconciliation evicts it (default 604800000 — 7 days). `0` evicts
   * at the first boot that classifies the owner as orphaned.
   */
  orphanRetentionMs?: number
}

/** How one owner session resolved during a reconciliation pass. */
type OwnerResolution =
  | { readonly kind: 'unowned' }
  | { readonly kind: 'live'; readonly agent: Agent }
  | { readonly kind: 'restorable' }
  | { readonly kind: 'orphan' }
  | { readonly kind: 'unknown' }

/**
 * One pending prior-incarnation record the pass is driving to a resolution.
 * A candidate is pending exactly while it sits in the pass's candidate map —
 * adoption and accounting both delete it — so no separate state field is
 * needed and the settlement sweeps can trust every entry to be live.
 */
interface PendingCandidate {
  /** The durable record as enumerated at pass start. */
  readonly record: JobRecord
  /** Whether the registry restored this record (fenced to its session or unowned). */
  readonly membership: 'owned' | 'unowned'
  /**
   * The pass's decision: `'adoptable'` waits for a producer resumer inside
   * the per-owner budget; any reason means the pass itself will settle the
   * record and account it with that reason.
   */
  decision: 'adoptable' | RunAbandonReason
  /**
   * The exact event detail for a supervisor-driven settlement; meaningful
   * only once {@link decision} is a reason (every classification path that
   * assigns a reason assigns this detail in the same statement pair).
   */
  detail: string
}

/** Terminal facts a settlement delivered, from whichever lane observed it. */
interface TerminalView {
  readonly id: JobId
  readonly kind: string
  readonly label: string
  /** Always a terminal status in practice; typed as the snapshot's wider union. */
  readonly status: JobSnapshot['status']
  /** Present when the settlement carried detail (the registry always writes one for its lanes). */
  readonly detail: string | undefined
  readonly reported: boolean
  readonly outputLimitBytes: number | undefined
}

/**
 * Whether one run/* account append durably reached the owner session.
 * `unavailable` names the deterministic no-lane case (the owner is neither
 * live nor reachable through persistence), never a lane failure.
 */
type RunEventAppendOutcome = 'recorded' | 'already-present' | 'unavailable'

/** One bounded reconciliation pass over the durable store. */
interface ReconcilePass {
  /** The store that triggered this pass, captured from the inject binding. */
  readonly store: JobStore
  /** Pending candidates by id; emptied as each resolves. */
  readonly candidates: Map<JobId, PendingCandidate>
  /** Aborts at the pass deadline, cancelling owner-restoration I/O. */
  readonly deadline: AbortController
  /** Async event/notice emissions, awaited before the pass completes. */
  readonly emissions: Set<Promise<void>>
  /** Notifies the wait loop that a candidate resolved. */
  nudge: (() => void) | undefined
}

/** One settled lane record's account: the structured reason and its detail. */
interface LaneSettlement {
  readonly reason: 'not-resumable' | 'resume-failed'
  readonly detail: string
}

const encoder = new TextEncoder()

/** Bound one model-facing notice to the producer's byte cap, keeping its head. */
function fitNotice(text: string, maxBytes: number | undefined): string {
  if (maxBytes === undefined || encoder.encode(text).byteLength <= maxBytes) return text
  const marker = '\n[notice truncated]'
  const markerBytes = encoder.encode(marker).byteLength
  if (maxBytes <= markerBytes) {
    const retainer = new TextRetainer({ kind: 'tail', maxBytes })
    retainer.push(text)
    return retainer.finish().text
  }
  const retainer = new TextRetainer({ kind: 'head', maxBytes: maxBytes - markerBytes })
  retainer.push(text)
  return `${retainer.finish().text}${marker}`
}

/** The bracketed status fragment shared by notices and summaries. */
function statusText(view: TerminalView): string {
  return view.detail !== undefined
    ? `[status: ${view.status}, ${view.detail}]`
    : `[status: ${view.status}]`
}

/** True when the session log already records a run/* reconciliation event for this job. */
function hasRunEvent(events: readonly SessionEvent[], jobId: JobId): boolean {
  return events.some(event => (event.type === 'run/resumed' || event.type === 'run/abandoned')
    && event.data.jobId === jobId)
}

interface WorkflowCloser {
  readonly type: 'tool-workflow/agent-end' | 'tool-workflow/run-end'
  readonly data: { readonly runId: WorkflowRunId; readonly seq?: number; readonly outcome?: 'cancelled'; readonly stopReason?: 'cancelled' }
}

/** Close every workflow member and run left open by a prior host incarnation. */
function workflowClosers(events: readonly SessionEvent[], jobId: JobId, kind: string): WorkflowCloser[] {
  if (kind !== 'workflow') return []
  // Workflow event declarations live in the optional producer package; inspect
  // their stable persistence shape without adding a reverse package edge.
  const loose = events as readonly { readonly type: string; readonly data: Record<string, unknown> }[]
  const detached = loose.find(event => event.type === 'run/detached'
    && event.data.jobId === jobId
    && event.data.kind === 'workflow')
  const runIdValue = detached?.data.runId
  if (typeof runIdValue !== 'string') return []
  const runId = runIdValue as WorkflowRunId
  if (loose.some(event => event.type === 'tool-workflow/run-end' && event.data.runId === runId)) return []
  const ended = new Set(loose
    .filter(event => event.type === 'tool-workflow/agent-end' && event.data.runId === runId)
    .map(event => event.data.seq))
  const closers: WorkflowCloser[] = loose
    .filter(event => event.type === 'tool-workflow/agent-start'
      && event.data.runId === runId
      && typeof event.data.seq === 'number'
      && !ended.has(event.data.seq))
    .map(event => ({
      type: 'tool-workflow/agent-end',
      data: { runId, seq: event.data.seq as number, outcome: 'cancelled' },
    }))
  closers.push({ type: 'tool-workflow/run-end', data: { runId, stopReason: 'cancelled' } })
  return closers
}

/**
 * Whether a terminal store record is a boot-settlement lane product worth
 * accounting, and with which account. The registry writes exactly two lane
 * details: its honest not-resumable settle (a null resume payload was never
 * resumable; a non-null one was offered to a resumer that declined) and the
 * thrown-resumer prefix (resume was attempted and failed).
 */
function laneSettlement(record: JobRecord): LaneSettlement | undefined {
  if (record.detail === REGISTRY_NOT_RESUMABLE_DETAIL) {
    return record.resumeSpec === null
      ? { reason: 'not-resumable', detail: DETAIL_NOT_RESUMABLE }
      : { reason: 'resume-failed', detail: record.detail }
  }
  if (record.detail !== null && record.detail.startsWith(REGISTRY_RESUME_THREW_PREFIX)) {
    return { reason: 'resume-failed', detail: record.detail }
  }
  return undefined
}

/**
 * The host-plane run-supervisor plugin. Plain class plugin (it registers no
 * `ctx` service of its own): constructed by the composition with its
 * schemastery-validated config, started at `Service.init`, and torn down
 * with its fiber. Reconciliation triggers once a `ctx.jobStore` activates
 * and re-triggers if the store service is replaced; each pass is idempotent,
 * keyed off `PROCESS_INCARNATION`, the persisted `reported` flag, and the
 * run/* events already present in the owner session's log.
 */
export class RunSupervisor {
  /** Schemastery schema validating and defaulting {@link Config}; misconfiguration fails loud at load. */
  static Config: z<Config> = z.object({
    resumeOnBoot: z.boolean().default(true),
    bootResumeTimeoutMs: z.number()
      .step(1)
      .min(1)
      .max(MAX_TIMER_DELAY_MS)
      .default(30_000),
    maxResumedRunsPerOwner: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(10),
    orphanRetentionMs: z.number()
      .step(1)
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(604_800_000),
  })

  /** The job registry is the only hard dependency; store, agents, and persistence are optional. */
  static inject = ['jobs']

  private readonly resumeOnBoot: boolean
  private readonly bootResumeTimeoutMs: number
  private readonly maxResumedRunsPerOwner: number
  private readonly orphanRetentionMs: number
  /** The currently running pass, observable by the service-level listeners. */
  private activePass: ReconcilePass | undefined
  /** Adopted records whose completion notices this process still owes, keyed by id. */
  private readonly adopted = new Map<JobId, PendingCandidate>()
  /** Serializes passes: a store replacement during a pass does not start a second one. */
  private passRunning = false

  constructor(private readonly ctx: Context, config: Config) {
    // Schemastery validates and fills the defaults before constructing the plugin.
    const resolved = config as Required<Config>
    this.resumeOnBoot = resolved.resumeOnBoot
    this.bootResumeTimeoutMs = resolved.bootResumeTimeoutMs
    this.maxResumedRunsPerOwner = resolved.maxResumedRunsPerOwner
    this.orphanRetentionMs = resolved.orphanRetentionMs
  }

  /**
   * Arm the service-level observation lanes, then reconcile whenever the
   * durable store is (or becomes) available. The inject fiber fires after the
   * registry's own earlier-registered store-adoption fiber, so the store view
   * this pass enumerates already reflects the registry's restore.
   */
  protected [Service.init](): void {
    this.ctx.effect(() => {
      const disposeDone = this.ctx.jobs.onJobDone((snapshot) => { this.onJobDone(snapshot) })
      const disposeAdopted = this.ctx.jobs.onJobAdopted(snapshot => this.onAdopted(snapshot))
      return () => { disposeDone(); disposeAdopted() }
    }, 'run-supervisor.observers')
    this.ctx.inject(['jobStore'], (storeCtx) => {
      // A reconciliation failure must never break the store's inject fiber.
      void this.runPass(storeCtx.jobStore).catch((error: unknown) => {
        this.ctx.logger.warn(`run-supervisor: boot reconciliation failed: ${String(error)}`)
      })
    })
  }

  /**
   * Run one bounded reconciliation pass. Concurrent triggers (a store
   * replacement mid-pass) collapse into the already running pass, whose
   * observation lanes follow every change the replacement commits.
   */
  private async runPass(store: JobStore): Promise<void> {
    if (this.passRunning) return
    this.passRunning = true
    const pass: ReconcilePass = {
      store,
      candidates: new Map(),
      deadline: new AbortController(),
      emissions: new Set(),
      nudge: undefined,
    }
    this.activePass = pass
    const timer = setTimeout(() => { pass.deadline.abort() }, this.bootResumeTimeoutMs)
    timer.unref()
    try {
      this.enumerate(pass)
      await this.accountAdoptionMarkers(pass)
      await this.resolveAndClassify(pass)
      this.accountLaneSettlements(pass)
      await this.evictExpiredOrphans(pass)
      this.settleReadyKinds(pass)
      await this.waitForCandidates(pass)
      this.settleRemaining(pass)
      await Promise.all([...pass.emissions])
    } finally {
      clearTimeout(timer)
      this.activePass = undefined
      this.passRunning = false
    }
  }

  /**
   * Enumerate the store's view and probe registry membership for pending
   * records. Same-incarnation records are live work — an in-process reload
   * must never mistake them for orphans.
   */
  private enumerate(pass: ReconcilePass): void {
    let unrestored = 0
    for (const record of pass.store.list()) {
      if (record.incarnation === PROCESS_INCARNATION) continue
      if (record.status !== 'running' && record.status !== 'stopping') continue
      // The registry fences owned records to their session, so membership
      // is probed by which error get() throws: 'unknown job' means this
      // registry never restored the record (persist disabled or a degraded
      // write) and no public lane can drive it.
      let membership: 'owned' | 'unowned'
      try {
        this.ctx.jobs.get(record.id)
        membership = 'unowned'
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith('unknown job')) {
          unrestored += 1
          continue
        }
        membership = 'owned'
      }
      pass.candidates.set(record.id, {
        record, membership, decision: 'adoptable', detail: '',
      })
    }
    if (unrestored > 0) {
      this.ctx.logger.warn(`run-supervisor: ${unrestored} durable job record(s) were not restored by the registry (persist disabled?) and cannot be reconciled`)
    }
  }

  /**
   * Account every adoption marker a previous pass left durable. The registry
   * commits the re-stamped record — its own incarnation plus the prior one as
   * `adoptedFromIncarnation` — before it announces the adoption, so a crash
   * or a supervisor that mounted after the resumer can leave the adoption
   * unaccounted; the marker is the proof that lets this pass append the
   * `run/resumed` the owner never got. The account names the marker: the
   * incarnation that wrote the record the missed adoption took over, exactly
   * as the live {@link onAdopted} lane would have named it. The marker
   * clears only after the append is confirmed recorded or found already
   * present — a lane failure or an owner no lane can reach keeps it for a
   * later boot. Terminal records keep their marker — the settlement already
   * accounted the run — and a cleared marker cannot double-account a later
   * boot.
   */
  private async accountAdoptionMarkers(pass: ReconcilePass): Promise<void> {
    for (const record of pass.store.list()) {
      if (record.adoptedFromIncarnation === undefined) continue
      if (record.status !== 'running' && record.status !== 'stopping') continue
      const candidate: PendingCandidate = {
        record: { ...record, incarnation: record.adoptedFromIncarnation },
        membership: 'unowned',
        decision: 'adoptable',
        detail: '',
      }
      const owner = record.ownerSession ?? undefined
      if (owner !== undefined) {
        // The marker clears only once the account is durably recorded (or
        // found already present); a lane failure or an unreachable owner
        // retains it for a later boot.
        let outcome: RunEventAppendOutcome
        try {
          outcome = await this.emitResumed(owner, candidate)
        } catch (error: unknown) {
          this.ctx.logger.warn(`run-supervisor: failed to record a reconciliation outcome: ${String(error)}`)
          continue
        }
        if (outcome === 'unavailable') continue
      }
      const { adoptedFromIncarnation: _marker, ...cleared } = record
      await pass.store.put(cleared)
    }
  }

  /**
   * Resolve every candidate's owner and apply pass policy: disabled boot
   * resume, orphan owners, and the per-owner adoption budget turn into
   * settle decisions; the rest wait for a producer resumer.
   */
  private async resolveAndClassify(pass: ReconcilePass): Promise<void> {
    const groups = new Map<SessionId | undefined, PendingCandidate[]>()
    for (const candidate of pass.candidates.values()) {
      const key = candidate.record.ownerSession ?? undefined
      const group = groups.get(key) ?? []
      group.push(candidate)
      groups.set(key, group)
    }
    for (const [session, group] of groups) {
      if (pass.deadline.signal.aborted) return
      const resolution = session === undefined
        ? { kind: 'unowned' } as const
        : await this.resolveOwner(pass, session)
      group.sort((left, right) => left.record.startedAt - right.record.startedAt
        || String(left.record.id).localeCompare(String(right.record.id)))
      let budget = this.maxResumedRunsPerOwner
      for (const candidate of group) {
        if (!this.resumeOnBoot) {
          candidate.decision = 'not-resumable'
          candidate.detail = DETAIL_NOT_RESUMABLE
          continue
        }
        if (resolution.kind === 'orphan') {
          candidate.decision = 'owner-unavailable'
          candidate.detail = DETAIL_OWNER_UNAVAILABLE
          continue
        }
        // Live, restorable, unknown, and unowned owners may all still be
        // adopted by a producer resumer; the budget bounds how many.
        if (budget > 0) {
          budget -= 1
          continue
        }
        candidate.decision = 'not-resumable'
        candidate.detail = DETAIL_RESUME_CAP
      }
    }
  }

  /**
   * Account for terminal records the boot restore already settled through
   * the registry's honest lanes: emit `run/abandoned` and deliver the one
   * completion notice an unreported record is owed. Records the model
   * already collected (`reported`) stay silent, and one failed emission
   * never aborts the rest of the accounting.
   */
  private accountLaneSettlements(pass: ReconcilePass): void {
    for (const record of pass.store.list()) {
      if (pass.deadline.signal.aborted) return
      if (record.incarnation === PROCESS_INCARNATION) continue
      if (record.status === 'running' || record.status === 'stopping') continue
      const settlement = laneSettlement(record)
      if (settlement === undefined || record.reported) continue
      const owner = record.ownerSession ?? undefined
      if (owner === undefined) continue
      const view: TerminalView = {
        id: record.id,
        kind: record.kind,
        label: record.label,
        status: record.status,
        detail: settlement.detail,
        reported: record.reported,
        outputLimitBytes: record.outputLimitBytes ?? undefined,
      }
      this.track(pass, this.emitAbandoned(pass, owner, view, settlement.reason))
    }
  }

  /**
   * Evict terminal records whose owner session is neither live nor listed by
   * persistence once `orphanRetentionMs` has passed since they settled. The
   * in-memory restored copy lingers fenced to its dead session (invisible to
   * every caller) until process exit; the durable eviction is what bounds how
   * long the orphan stays listable across boots.
   */
  private async evictExpiredOrphans(pass: ReconcilePass): Promise<void> {
    const expired: JobRecord[] = []
    const now = Date.now()
    for (const record of pass.store.list()) {
      if (record.incarnation === PROCESS_INCARNATION) continue
      if (record.status === 'running' || record.status === 'stopping') continue
      if (record.ownerSession === null || record.finishedAt === null) continue
      if (record.finishedAt + this.orphanRetentionMs > now) continue
      expired.push(record)
    }
    if (expired.length === 0) return
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return
    let listed: Set<SessionId>
    try {
      const headers = await persistence.list(pass.deadline.signal)
      listed = new Set(headers.map(header => header.id))
    } catch (error: unknown) {
      if (!pass.deadline.signal.aborted) {
        this.ctx.logger.warn(`run-supervisor: cannot classify orphan records for retention: ${String(error)}`)
      }
      return
    }
    const agents = this.ctx.get('agents')
    for (const record of expired) {
      const session = record.ownerSession as SessionId
      if (listed.has(session) || agents?.get(session) !== undefined) continue
      try {
        await pass.store.delete(record.id)
      } catch (error: unknown) {
        this.ctx.logger.warn(`run-supervisor: failed to evict expired orphan record ${record.id}: ${String(error)}`)
      }
    }
  }

  /**
   * Settle every pending candidate of kinds that have no adoptable candidate
   * left. The declining resumer replays a whole kind at once, so a kind with
   * adoptable records still waiting keeps its settle-targets pending until
   * those resolve or the deadline passes.
   */
  private settleReadyKinds(pass: ReconcilePass): void {
    const adoptableKinds = new Set<string>()
    for (const candidate of pass.candidates.values()) {
      if (candidate.decision === 'adoptable') adoptableKinds.add(candidate.record.kind)
    }
    const kinds = new Set<string>()
    for (const candidate of pass.candidates.values()) {
      if (candidate.decision !== 'adoptable' && !adoptableKinds.has(candidate.record.kind)) {
        kinds.add(candidate.record.kind)
      }
    }
    for (const kind of kinds) this.declineKind(kind)
  }

  /**
   * Settle every still-pending candidate at the pass deadline: adoptable
   * ones account as `'reconcile-timeout'`, earlier decisions keep theirs.
   * Every remaining candidate is pending by the candidate-map invariant.
   */
  private settleRemaining(pass: ReconcilePass): void {
    const kinds = new Set<string>()
    for (const candidate of pass.candidates.values()) {
      if (candidate.decision === 'adoptable') {
        candidate.decision = 'reconcile-timeout'
        candidate.detail = DETAIL_RECONCILE_TIMEOUT
      }
      kinds.add(candidate.record.kind)
    }
    for (const kind of kinds) this.declineKind(kind)
  }

  /**
   * Drive one kind's pending records to honest settlement by registering a
   * declining resumer: the registry's replay settles each as `failed`
   * through first-wins, preserving `reported` and notifying completion
   * listeners — which is what routes the settlement back to
   * {@link onJobDone} for the session account. A producer resumer that won
   * the kind first makes registration throw; its own replay already decided
   * those records, and the observation lanes account for them.
   */
  private declineKind(kind: string): void {
    try {
      const dispose = this.ctx.jobs.registerResumer(kind as JobKind, () => undefined)
      dispose()
    } catch {
      // A producer resumer owns this kind now; its replay adopts or settles
      // every pending record of the kind and the observers account for them.
    }
  }

  /** Wait until every candidate resolved or the pass deadline aborted the wait. */
  private async waitForCandidates(pass: ReconcilePass): Promise<void> {
    while (pass.candidates.size > 0 && !pass.deadline.signal.aborted) {
      // The deadline timer is the only aborter and fires on a macrotask, so
      // the loop condition and the abort listener between them cover every
      // exit; there is no synchronous path into an already-aborted wait.
      await new Promise<void>((resolve) => {
        pass.nudge = resolve
        pass.deadline.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    pass.nudge = undefined
  }

  /** Wake the pass wait loop after a candidate resolved. */
  private nudge(pass: ReconcilePass): void {
    const nudge = pass.nudge
    if (nudge !== undefined) {
      pass.nudge = undefined
      nudge()
    }
  }


  /** Legacy change callback retained as a no-op compatibility lane. */
  private onJobsChanged(): void {}

  /**
   * Account for an adoption delivered by the registry after durable commit.
   * The registry awaits this account before it attaches the producer's
   * completion wiring, so a settlement can never race ahead of the
   * `run/resumed` that classifies it.
   */
  private async onAdopted(snapshot: JobSnapshot): Promise<void> {
    this.onJobsChanged()
    const pass = this.activePass
    if (pass === undefined) return
    const candidate = pass.candidates.get(snapshot.id)
    if (candidate === undefined) return
    pass.candidates.delete(snapshot.id)
    this.adopted.set(snapshot.id, candidate)
    this.settleReadyKinds(pass)
    this.nudge(pass)
    const owner = candidate.record.ownerSession ?? undefined
    if (owner !== undefined) await this.emitResumed(owner, candidate)
  }

  /**
   * Account for one settlement. Pending candidates of the active pass are
   * reconciliation outcomes (a resumer declined or threw, or the record was
   * killed while awaiting resume); adopted records owe their completion
   * notice to the owner that resumed them.
   */
  private onJobDone(snapshot: JobSnapshot): void {
    const pass = this.activePass
    if (pass !== undefined) {
      const candidate = pass.candidates.get(snapshot.id)
      if (candidate !== undefined) {
        pass.candidates.delete(snapshot.id)
        if (snapshot.status !== 'killed') {
          const owner = candidate.record.ownerSession ?? undefined
          if (owner !== undefined) {
            // Supervisor-driven settlements carry the pass's own reason; a
            // producer resumer's decline or throw is a failed resume. The
            // registry's lanes always write a detail; the fallback only
            // covers a producer outcome that supplied none.
            const supervisorDriven = candidate.decision !== 'adoptable'
            const view: TerminalView = {
              id: snapshot.id,
              kind: snapshot.kind,
              label: snapshot.label,
              status: snapshot.status,
              detail: supervisorDriven
                ? candidate.detail
                : snapshot.detail ?? REGISTRY_NOT_RESUMABLE_DETAIL,
              reported: snapshot.reported,
              outputLimitBytes: snapshot.outputLimitBytes,
            }
            this.track(pass, this.emitAbandoned(
              pass,
              owner,
              view,
              supervisorDriven ? candidate.decision as RunAbandonReason : 'resume-failed',
            ))
          }
        }
        this.settleReadyKinds(pass)
        this.nudge(pass)
        return
      }
    }
    const adopted = this.adopted.get(snapshot.id)
    if (adopted !== undefined) {
      this.adopted.delete(snapshot.id)
      if (!snapshot.reported) {
        const owner = adopted.record.ownerSession ?? undefined
        if (owner !== undefined) {
          const view: TerminalView = {
            id: snapshot.id,
            kind: snapshot.kind,
            label: snapshot.label,
            status: snapshot.status,
            detail: snapshot.detail,
            reported: snapshot.reported,
            outputLimitBytes: snapshot.outputLimitBytes,
          }
          this.deliverNoticeWhenLive(pass, owner, view)
        }
      }
    }
  }

  /**
   * Track one async emission inside the pass, containing its failure to a
   * warning. Without an active pass (an adopted record settling after
   * reconciliation ended) the emission is still contained, just not awaited.
   */
  private track(pass: ReconcilePass | undefined, emission: Promise<void>): void {
    const contained = emission.catch((error: unknown) => {
      this.ctx.logger.warn(`run-supervisor: failed to record a reconciliation outcome: ${String(error)}`)
    })
    if (pass === undefined) return
    pass.emissions.add(contained)
    void contained.finally(() => { pass.emissions.delete(contained) })
  }

  /**
   * Resolve one owner session for this pass: a live agent wins, else the
   * session must restore through the real resume path
   * (`sessionPersistence.prepare`, disposed immediately — restorability is
   * the fact, not the session object). Without a persistence seam the owner
   * is unknown rather than orphaned: nothing may be settled or evicted on
   * the absence of evidence.
   */
  private async resolveOwner(pass: ReconcilePass, session: SessionId): Promise<OwnerResolution> {
    const live = this.ctx.get('agents')?.get(session)
    if (live !== undefined) return { kind: 'live', agent: live }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return { kind: 'unknown' }
    try {
      using preparation = await persistence.prepare(session, pass.deadline.signal)
      void preparation
      return { kind: 'restorable' }
    } catch {
      // A deadline abort is not evidence about the owner; classify it
      // unknown so the deadline sweep — not an owner verdict — accounts it.
      return pass.deadline.signal.aborted ? { kind: 'unknown' } : { kind: 'orphan' }
    }
  }

  /**
   * Append `run/resumed` to the owner session when it is reachable. The
   * event is idempotent across boots: a log that already carries a run/*
   * event for this job is left alone. The outcome tells the marker lane
   * whether the account is durable (`recorded`/`already-present`) or no lane
   * could reach the session (`unavailable`).
   */
  private async emitResumed(owner: SessionId, candidate: PendingCandidate): Promise<RunEventAppendOutcome> {
    const data: RunResumedData = {
      jobId: candidate.record.id,
      kind: candidate.record.kind,
      priorIncarnation: candidate.record.incarnation,
    }
    return this.appendRunEvent(owner, { type: 'run/resumed', data })
  }

  /**
   * Append `run/abandoned` to the owner session and deliver the one
   * completion notice an unreported settlement owes a live owner.
   */
  private async emitAbandoned(
    pass: ReconcilePass,
    owner: SessionId,
    view: TerminalView,
    reason: RunAbandonReason,
  ): Promise<void> {
    const data: RunAbandonedData = {
      jobId: view.id,
      kind: view.kind,
      reason,
      detail: view.detail ?? '',
    }
    await this.appendRunEvent(owner, { type: 'run/abandoned', data })
    if (!view.reported) this.deliverNoticeWhenLive(pass, owner, view)
  }

  /** Deliver exactly one completion notice to a live owner, then claim it reported. */
  private deliverNoticeWhenLive(pass: ReconcilePass | undefined, owner: SessionId, view: TerminalView): void {
    const agent = this.ctx.get('agents')?.get(owner)
    if (agent === undefined) return
    const text = fitNotice(
      `background job ${view.id} (${view.kind}: ${view.label}) finished ${statusText(view)}. Read its output with job_output.`,
      view.outputLimitBytes,
    )
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'run-supervisor',
        form: 'notice',
        summary: boundContextSummary(`${view.kind} ${view.label} ${statusText(view)}`),
      },
    }))
    // Claim the terminal report so no later boot re-delivers. wait() marks a
    // terminal job reported without consuming its output cursor (read()
    // would), and a record already evicted simply leaves nothing to mark.
    const claimed = this.ctx.jobs.wait(view.id, 1, agent).then(() => {}, () => {})
    this.track(pass, claimed)
  }

  /**
   * Append one run/* event to the owner session through whichever lane can
   * reach it: the live session when the agent is registered, else a durable
   * offline append through persistence at the log's next seq. An offline
   * append that loses a race with a session coming live retries through the
   * live lane; a session that cannot be reached at all keeps its record's
   * account in the job list and store, reported as `unavailable` so the
   * adoption-marker lane retains its proof for a later boot. A lane failure
   * (a load or append rejection no live session can absorb) still throws.
   */
  private async appendRunEvent(
    owner: SessionId,
    event:
      | { readonly type: 'run/resumed'; readonly data: RunResumedData }
      | { readonly type: 'run/abandoned'; readonly data: RunAbandonedData },
  ): Promise<RunEventAppendOutcome> {
    const live = this.ctx.get('agents')?.get(owner)
    if (live !== undefined) {
      if (hasRunEvent(live.session.events, event.data.jobId)) return 'already-present'
      if (event.type === 'run/resumed') {
        live.session.append('run/resumed', event.data)
      } else {
        for (const closer of workflowClosers(live.session.events, event.data.jobId, event.data.kind)) {
          (live.session.append as unknown as (type: string, data: unknown) => void)(closer.type, closer.data)
        }
        live.session.append('run/abandoned', event.data)
      }
      return 'recorded'
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return 'unavailable'
    const loaded = await persistence.load(owner)
    if (hasRunEvent(loaded.events, event.data.jobId)) return 'already-present'
    const closers = event.type === 'run/abandoned'
      ? workflowClosers(loaded.events, event.data.jobId, event.data.kind)
      : []
    const batch = [...closers, event].map((item, index) => ({
      type: item.type, seq: loaded.events.length + index, time: Date.now(), data: item.data,
    }) as SessionEvent)
    try {
      await persistence.append(owner, batch)
      return 'recorded'
    } catch (error: unknown) {
      // The session may have come live between resolution and append (its
      // next seq moved); retry through the live lane before giving up.
      const raced = this.ctx.get('agents')?.get(owner)
      if (raced === undefined) throw error
      if (hasRunEvent(raced.session.events, event.data.jobId)) return 'already-present'
      if (event.type === 'run/resumed') {
        raced.session.append('run/resumed', event.data)
      } else {
        for (const closer of workflowClosers(raced.session.events, event.data.jobId, event.data.kind)) {
          (raced.session.append as unknown as (type: string, data: unknown) => void)(closer.type, closer.data)
        }
        raced.session.append('run/abandoned', event.data)
      }
      return 'recorded'
    }
  }
}

export default RunSupervisor
