# Background Task Runtime

English | [中文](jobs.zh.md)

Types shared by long-running producers, `ctx.jobs`, and job controls. The [runtime Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) owns the design; this page records the exact fields and variants from [`packages/jobs/jobs/src/types.ts`](../../packages/jobs/jobs/src/types.ts).

## Ids and status

`JobId` is a [branded id](core.md#branded-ids) generated as `<kind>-<uuid>` — or `<kind>-<idHint>` when the producer supplies a stable fragment — so a persisted id is never re-minted for different work. Access control relies on owner authorization, not id secrecy. `JobKind` derives from a merge-extensible map; the registry treats kinds as opaque id namespaces. Snapshots additionally carry a per-owner 1-based display `ordinal`, the short model-facing handle beside the durable id.

```ts type-equiv
/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}
```

`JobStatus` is `'running' | 'stopping' | 'completed' | 'killed' | 'failed'`; producer-specific facts belong in `JobSnapshot.detail`.

## Producer contract

`JobStart` declares identity and a starter. The runtime finishes preflight before calling `run()` and commits without a later failable step. Producers own execution resources; the runtime owns identity, access, and lifecycle state.

```ts type-equiv
/**
 * Producer declaration passed to {@link JobRegistry.start}. The runtime
 * preflights access and cleanup before invoking {@link run}; the producer owns
 * execution resources while the runtime owns identity and lifecycle state.
 */
interface JobStart {
  /** Producer kind — also the id prefix (`bash`, `subagent`, …). */
  kind: JobKind
  /** One-line model-facing label (the command; the delegation description). */
  label: string
  /**
   * Optional UTF-8 byte cap for each complete model-facing completion notice or
   * output read, including controller status metadata.
   */
  outputLimitBytes?: number
  /**
   * Owning live agent. Access is fenced by its session id, and agent disposal
   * cancels and awaits the job. The instance must be the one currently
   * registered under its agent id. Omitting the owner creates an unowned job,
   * open to any caller until service disposal.
   */
  owner?: Agent
  /**
   * Durable resume policy for this producer's work. Only consulted when the
   * registry persists records; omission means a persisted record is not
   * resumable and is settled honestly after a host restart.
   */
  durability?: JobDurability
  /**
   * Producer-supplied stable id fragment: the job registers as
   * `<kind>-<idHint>` instead of the minted `<kind>-<uuid>`. Must be
   * non-empty and must not collide with a registered or persisted id — a
   * collision fails the registration loudly before {@link run} is invoked.
   */
  idHint?: string
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once; a throw leaves nothing registered, and the producer must clean up any
   * partially started resources.
   */
  run(): JobHooks
}
```

`JobHooks.done` resolves after the producer releases its resources, not merely when work finishes. Optional `readOutput` distinguishes consuming stream jobs from final-output-only jobs.

```ts type-equiv
/** Hooks through which the runtime controls and observes producer work. */
interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually settle
   * {@link done}; throws propagate. The optional reason is forwarded verbatim.
   */
  cancel(reason?: string): void
  /**
   * Resolves after the producer releases its resources, not merely when work
   * finishes. Must not reject; the runtime converts a rejection to `failed`.
   * If teardown cancellation throws, the runtime may force-fail only the
   * registry record without claiming that the work stopped.
   */
  done: Promise<JobOutcome>
  /**
   * Consume output produced since the previous call. The producer formats
   * truncation and spill notices. Absence marks a final-output-only job; each
   * job has one consuming cursor.
   */
  readOutput?(): string
}
```

```ts type-equiv
/** Terminal result supplied by a producer through {@link JobHooks.done}. */
interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific detail rendered into status lines ('exit code: 3', 'max-tokens'). */
  detail?: string
  /** Final output for jobs without `readOutput`; stream jobs leave it unset. */
  output?: string
}
```

## Consumer views

Snapshots are fresh read-only projections. `ownerSession` carries the shared `SessionId` used for authorization; completion listeners separately receive the exact owner object used for lifecycle cleanup. `reported` suppresses a completion notice after another reporter has delivered or committed to deliver the terminal state, including the teardown cancel that drains an owner or the service.

```ts type-equiv
/**
 * A read-only projection of one job, safe to hand to listeners and tools —
 * a fresh object per call, never live registry state.
 */
interface JobSnapshot {
  /** The registry-issued id (`<kind>-<uuid>`, or `<kind>-<idHint>`). */
  id: JobId
  /**
   * 1-based display ordinal within the owner's bucket (registration order),
   * kept for model-facing lists so the model never has to repeat a 36-char
   * uuid to tell jobs apart. Process-local presentation state: restored
   * records are re-numbered in startedAt order on boot, so the ordinal is not
   * stable across restarts — the id is.
   */
  ordinal: number
  /** The producer kind the job was registered with. */
  kind: JobKind
  /** The producer-supplied one-line label. */
  label: string
  /** Producer-owned cap for complete model-facing notices and output reads. */
  outputLimitBytes?: number
  /**
   * Owner session id used for authorization and correlation; absent for
   * unowned jobs. Completion listeners receive the exact {@link Agent}
   * separately through {@link JobDoneListener}.
   */
  ownerSession?: SessionId
  /** Current lifecycle state. */
  status: JobStatus
  /**
   * Whether a persisted record of this job could be re-adopted after a host
   * restart: true exactly when the producer supplied a non-null
   * {@link JobDurability.resumeSpec}.
   */
  resumable: boolean
  /**
   * The process incarnation that owns the record. Matches the current
   * process's `PROCESS_INCARNATION` for work started (or adopted) here, and
   * names the writing process for a restored record still awaiting a resumer.
   */
  incarnation: string
  /** Kind-specific status detail, present once the producer supplied one (usually terminal). */
  detail?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while `running`/`stopping`. */
  finishedAt?: number
  /**
   * True when a kill, read, wait, or teardown cancel has reported or committed
   * to report the terminal state. Completion reporters suppress redundant
   * notices when set. Teardown claims it because the owner or service being
   * destroyed leaves no reader: a reporter that opens a turn on notice would
   * otherwise spend a model request per teardown layer.
   */
  reported: boolean
}
```

```ts type-equiv
/** Output and post-read state returned by {@link JobRegistry.read}. */
interface JobRead {
  /**
   * Stream kinds: the consuming delta since the previous read. Final-output
   * kinds: empty while live, the terminal {@link JobOutcome.output} (or
   * empty) once settled — idempotent, never consumed.
   */
  text: string
  /** The job's state at read time. */
  snapshot: JobSnapshot
}
```

## Service behavior

The abstract [`JobRegistry`](../../packages/jobs/jobs/src/index.ts) Service Definition specifies atomic `start`, caller-scoped `get` and `list`, `read`, `kill`, bounded `wait`, failure-isolated `onJobDone` and `onJobsChanged` listeners, and `attachController`; [`LocalJobRegistry`](../../packages/jobs/jobs-local/src/index.ts) is the process-local Service Provider. Authorization compares owner sessions; owner cleanup and admission use the exact registered `Agent` instance. The local provider's positive-safe-integer `maxConcurrentJobsPerOwner` config defaults to `10` and counts `running` plus `stopping` records per exact owner, with one shared bucket for unowned jobs; terminal producer settlement releases capacity. See [`dsh-jobs`](../../packages/jobs/jobs/README.md) for the Service Definition contract, [`dsh-jobs-local`](../../packages/jobs/jobs-local/README.md) for the registry lifecycle and admission policy, and [`dsh-tool-jobs`](../../packages/jobs/tool-jobs/README.md) for the model-facing Consumer.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjobs--jobregistry-abstract-seam"></a>

### `ctx.jobs` — `JobRegistry` (abstract seam)

Abstract background job registry. Subclass, implement the abstract methods, and load the subclass as a plugin — it registers as `ctx.jobs` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Registrations outlive producer and controller fibers. Owner and service disposal cancel live work and await compliant producers; a throwing teardown cancel force-fails only the record. Teardown cancellation also marks the record reported, because a record its owner is being destroyed for has no reader left.
- Owned-job access is fenced by the owner's session id. Ids are predictable, so authorization — not secrecy — is the boundary.
- Settlement is first-wins: one terminal record, released waiters, and one round of contained listener notification, even against a late producer outcome. Completion is announced last, after the record is committed and every other observer of the settlement has seen it, because a reporter may open a model turn synchronously.
- start refuses work while no attached job controller serves the spec's owner, so a producer cannot start work that owner cannot collect or stop. One registry serves every composition in the process, so this question — and completion-listener delivery — is owner-relative rather than process-wide: registrations made from an unscoped context serve every owner, and registrations made under an agent composition's scope serve exactly the agents composed under it.

```ts cordis-catalog
/**
 * Preflight access, validation, owner cleanup, and implementation-owned
 * admission before starting and atomically registering work. Any preflight
 * rejection leaves no job id or execution resource. A throwing starter
 * leaves nothing registered; after it returns, registration cannot fail.
 * Settlement records the outcome, notifies listeners, and releases waiters.
 * @param spec - job identity, owner, and synchronous starter.
 * @returns the registry-issued `<kind>-<uuid>` (or `<kind>-<idHint>`) id.
 */
abstract start(spec: JobStart): JobId

/**
 * List caller-owned and unowned jobs in registration order without exposing
 * another session's labels.
 * @param caller - reading agent; a non-agent caller sees only unowned jobs.
 * @returns fresh snapshots.
 */
abstract list(caller?: Agent): JobSnapshot[]

/**
 * Return a non-consuming snapshot without changing its read cursor or notice
 * state. Throws for an unknown or foreign job.
 * @param id - job to look up.
 * @param caller - reading agent checked against the owner.
 * @returns a fresh snapshot.
 */
abstract get(id: JobId, caller?: Agent): JobSnapshot

/**
 * Read the next stream delta, or the idempotent final output after settlement.
 * A terminal read marks the job reported. Throws for an unknown or foreign
 * job.
 * @param id - job to read.
 * @param caller - reading agent checked against the owner.
 * @returns output text and the post-read snapshot.
 */
abstract read(id: JobId, caller?: Agent): JobRead

/**
 * Request cancellation, then mark the job stopping and reported. A producer
 * throw propagates without changing job state. Throws for an unknown or
 * foreign job.
 * @param id - job to cancel.
 * @param caller - killing agent checked against the owner.
 * @param reason - logged reason forwarded to the producer.
 * @returns `requested` for live work, otherwise `already-finished`.
 */
abstract kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'

/**
 * Wait for settlement or timeout without cancelling the job. Caller abort
 * rejects only while the job is live; after settlement the terminal
 * snapshot wins so a notice suppressed for this waiter is still delivered.
 * Throws for invalid, unknown, or foreign input.
 * @param id - job to wait for.
 * @param timeoutMs - positive finite wait bound in milliseconds.
 * @param caller - waiting agent checked against the owner.
 * @param signal - optional cancellation of the wait itself.
 * @returns snapshot at settlement or timeout.
 */
abstract wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot>

/**
 * Register an effect-scoped completion listener. It receives the settlements
 * of the owners its registering context's scope covers; each listener is
 * contained; returned promises are observed but not awaited. No listener runs
 * after service disposal.
 * @param listener - receives each terminal snapshot and its exact owner.
 * @returns disposer that unregisters the listener.
 */
abstract onJobDone(listener: JobDoneListener): () => void

/**
/**
 * Register an effect-scoped observer of visible-set changes. It fires after
 * every commit that changes what {@link list} returns for that owner —
 * registration, every stopping transition (including the one teardown
 * performs before it awaits a slow producer), settlement, owner-disposal
 * removal, and the emptying that service disposal commits — so an observer
 * re-reads rather than accumulating deltas.
 *
 * Delivery is owner-relative on the same terms as {@link onJobDone}: an
 * observer registered from an unscoped context — a host composition's own
 * carrier — sees every owner, while one registered under an agent
 * composition's scope sees exactly the agents composed under it.
 *
 * This is not a superset of {@link onJobDone}: that one delivers the terminal
 * record under first-wins semantics a job controller couples to notice
 * delivery, while this one carries no delivery meaning and marks nothing
 * reported. Listeners are contained and never awaited.
 * @param listener - receives the owner whose visible set changed, or
 *   `undefined` when an unowned job changed and every caller's set did.
 * @returns disposer that unregisters the listener.
 */
abstract onJobsChanged(listener: JobsChangedListener): () => void

/**
 * Register a resume handler for one job kind. On boot the registry replays
 * every non-terminal persisted record of this kind that a previous process
 * incarnation wrote: a handler that returns hooks adopts the record under
 * its original id; `undefined` settles it honestly as `failed` with detail
 * `'not resumable after host restart'`. Registration is an effect scoped to
 * the registering context; at most one resumer may serve a kind at a time,
 * and a duplicate registration fails loudly.
 * @param kind - producer kind whose persisted records the handler serves.
 * @param resume - decides adoption per record; see {@link JobResumer}.
 * @returns disposer that unregisters the handler.
 */
abstract registerResumer(kind: JobKind, resume: JobResumer): () => void

/**
 * Attach an effect-scoped controller that can read and stop jobs. It serves the
 * owners its registering context's scope covers, and {@link start} refuses an
 * owner no attached controller serves.
 * @param name - diagnostic label; duplicate names remain independent.
 * @returns disposer that detaches this controller.
 */
abstract attachController(name: string): () => void
```

Types: [Agent](core.md)

Source: [`packages/jobs/jobs/src/index.ts`](../../packages/jobs/jobs/src/index.ts)

<a id="ctxjobstore--jobstore-abstract-seam"></a>

### `ctx.jobStore` — `JobStore` (abstract seam)

Abstract durable job store. Subclass, implement the abstract members, and load the subclass as a plugin — it registers as `ctx.jobStore` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior).

Contract highlights for implementations:

- Reads are synchronous over authoritative in-memory state and reflect writes that are still queued (read-your-writes).
- put replaces the whole record (job records are monotone lifecycle snapshots, so last-write-wins per id is correct) and its returned promise settles with the durability of the latest queued value.
- A rejected write must reject the caller's promise; the caller — not the store — owns the degrade decision.

```ts cordis-catalog
/**
 * Snapshot every persisted record, including values still queued to write.
 * @returns fresh array of stored records in medium order with queued
 * overlays applied.
 */
abstract list(): JobRecord[]

/**
 * Read one record, including a value still queued to write.
 * @param id - record key.
 * @returns the record, or `undefined` when absent.
 */
abstract get(id: JobId): JobRecord | undefined

/**
 * Insert or replace one record durably. Writes may be coalesced per id;
 * the promise settles with the durability of the latest value queued for
 * that id and rejects when the medium refuses it.
 * @param record - the full new record (no partial merge).
 * @returns resolution after the write (or its coalesced successor) lands.
 */
abstract put(record: JobRecord): Promise<void>

/**
 * Delete one record durably, discarding any queued write for the same id
 * (the queued writers' promises resolve — their record was superseded by a
 * deliberate removal, not lost).
 * @param id - record key.
 * @returns `true` when a stored or queued record existed.
 */
abstract delete(id: JobId): Promise<boolean>
```

Source: [`packages/jobs/jobs-store-domain/src/index.ts`](../../packages/jobs/jobs-store-domain/src/index.ts)
<!-- END GENERATED cordis-surface -->
