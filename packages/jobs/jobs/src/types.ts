/**
 * Types shared by job producers, the registry, and controllers. The
 * service implementation lives in `./index.ts`.
 * @module @deepseek-ai/dsh-jobs/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session'
import type { JobId } from './brand.ts'

export { JobId } from './brand.ts'

/**
 * Task lifecycle: `running`, optionally `stopping`, then exactly one terminal
 * status. Producer-specific facts belong in {@link JobSnapshot.detail}.
 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
export interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}

/** The merge-extensible union of registered producer kind names. */
export type JobKind = JobKindMap[keyof JobKindMap]

/** Terminal result supplied by a producer through {@link JobHooks.done}. */
export interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific detail rendered into status lines ('exit code: 3', 'max-tokens'). */
  detail?: string
  /** Final output for jobs without `readOutput`; stream jobs leave it unset. */
  output?: string
}

/**
 * Durable resume policy carried by {@link JobStart.durability}. Absence of the
 * whole block — or of {@link resumeSpec} — means a persisted record for this
 * job cannot be re-adopted after a host restart and boot reconciliation
 * settles it honestly instead.
 */
export interface JobDurability {
  /**
   * Producer-owned JSON re-start payload handed back to the {@link JobResumer}
   * registered for this kind on a later boot. Absent (or `null`) means the
   * work is not resumable after a host restart.
   */
  resumeSpec?: JsonValue
  /**
   * Session that owns the durable record's lifecycle events. When {@link
   * JobStart.owner} is also present the two must name the same session; the
   * registry fails the registration loudly on a mismatch.
   */
  recordSession?: SessionId
}

/**
 * Producer declaration passed to {@link JobRegistry.start}. The runtime
 * preflights access and cleanup before invoking {@link run}; the producer owns
 * execution resources while the runtime owns identity and lifecycle state.
 */
export interface JobStart {
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

/** Hooks through which the runtime controls and observes producer work. */
export interface JobHooks {
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

/**
 * A read-only projection of one job, safe to hand to listeners and tools —
 * a fresh object per call, never live registry state.
 */
export interface JobSnapshot {
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

/** Output and post-read state returned by {@link JobRegistry.read}. */
export interface JobRead {
  /**
   * Stream kinds: the consuming delta since the previous read. Final-output
   * kinds: empty while live, the terminal {@link JobOutcome.output} (or
   * empty) once settled — idempotent, never consumed.
   */
  text: string
  /** The job's state at read time. */
  snapshot: JobSnapshot
}

/**
 * Completion callback with the exact owner supplied at start, or `undefined`
 * for an unowned job. Returned promises are observed but not awaited.
 */
export type JobDoneListener = (
  snapshot: JobSnapshot,
  owner: Agent | undefined,
) => void | PromiseLike<void>

/**
 * One persisted non-terminal record offered to a {@link JobResumer} during
 * boot replay: the durable facts a producer needs to decide whether it can
 * re-adopt the work under the original id.
 */
export interface JobResumeCandidate {
  /** The original durable id; adoption keeps it. */
  readonly id: JobId
  /** Producer kind the record was registered with. */
  readonly kind: JobKind
  /** The producer-supplied one-line label. */
  readonly label: string
  /** Session that owned the record, when it had one. */
  readonly ownerSession?: SessionId
  /** The producer-owned re-start payload persisted at registration. */
  readonly resumeSpec: JsonValue
  /** Epoch ms when the job was originally registered. */
  readonly startedAt: number
  /** Incarnation of the process that wrote the record. */
  readonly priorIncarnation: string
}

/**
 * Deferred producer for a restored record. The registry durably records the
 * adoption and awaits its account observers before invoking {@link start}.
 */
export interface JobResumePlan {
  /**
   * Start the producer and return its hooks. Called at most once after adoption
   * commit; a throw settles the record as a failed resume.
   * @returns hooks for the newly started producer.
   */
  start(): JobHooks
}

/**
 * Resume handler for one job kind. Returning a deferred {@link JobResumePlan}
 * accepts the persisted record under its original id; returning `undefined`
 * declines it. The handler may inspect the candidate but must not start work.
 * A throw or decline settles the record honestly as `failed`.
 */
export type JobResumer = (candidate: JobResumeCandidate) => JobResumePlan | undefined

/**
 * Observation callback for a change to what one owner's {@link JobRegistry.list}
 * would return. It is owner-granular rather than job-granular because the
 * change may be a removal, which no per-job record can express, and because
 * its consumers re-read the whole visible set anyway.
 *
 * An `undefined` owner means an unowned job changed, so every caller's visible
 * set changed with it.
 */
export type JobsChangedListener = (owner: Agent | undefined) => void

/**
 * Listener for one restored job accepted by a producer resumer. Returned
 * promises settle before producer work starts. Returning `true` confirms the
 * listener durably accounted the adoption, allowing later registry mirrors to
 * omit the marker; `false` rejects the ownership transfer, while `void` is
 * observational. Throws are contained so observational listeners cannot
 * accidentally veto it.
 */
export type JobAdoptedListener = (
  snapshot: JobSnapshot,
  priorIncarnation: string,
) => void | boolean | PromiseLike<void | boolean>
