/**
 * Durable session events owned by the run supervisor. All three are log-only
 * (none is a `SurfaceEventType`) and none carries `ignorable: true`: a
 * reader that does not know a run's fate must refuse the log rather than skip
 * it, because these events are the model-visible account of what boot
 * reconciliation did to work that outlived its host process.
 *
 * @module @deepseek-ai/dsh-run-supervisor/types
 */

import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'

/** One durable run left its starting tool's call stack for supervisor ownership. */
export interface RunDetachedData {
  /** The durable job id the run registered under. */
  readonly jobId: JobId
  /** Producer kind the job was registered with. */
  readonly kind: string
  /** The producer-supplied one-line label. */
  readonly label: string
  /** The workflow run this job supervises, when the kind is 'workflow'. */
  readonly runId?: WorkflowRunId
  /** Whether a persisted record of this run can be re-adopted after a host restart. */
  readonly resumable: boolean
}

/** Boot reconciliation re-adopted a run that outlived its host process. */
export interface RunResumedData {
  /** The durable id the record was re-adopted under (unchanged). */
  readonly jobId: JobId
  /** Producer kind the record was registered with. */
  readonly kind: string
  /** Incarnation that wrote the record this resume adopted. */
  readonly priorIncarnation: string
}

/** Boot reconciliation could not resume a run and settled it honestly. */
export interface RunAbandonedData {
  /** The durable id of the record that was settled. */
  readonly jobId: JobId
  /** Producer kind the record was registered with. */
  readonly kind: string
  /**
   * Why the run was not resumed: it carried no resume payload
   * (`'not-resumable'`), its owning session could not be restored
   * (`'owner-unavailable'`), the reconciliation deadline passed
   * (`'reconcile-timeout'`), or a registered resumer declined or threw
   * (`'resume-failed'`).
   */
  readonly reason: 'not-resumable' | 'owner-unavailable' | 'reconcile-timeout' | 'resume-failed'
  /** Human-readable detail naming the exact reason, mirrored in completion notices. */
  readonly detail: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A durable run was handed from its starting tool to the supervisor.
     * Declared here so the run/* vocabulary has one home; EMITTED by the
     * later workflow slice (`@deepseek-ai/dsh-tool-workflow` under
     * `ownership: 'supervisor'`), never by the run supervisor itself.
     * @param data - stable run identity and resume policy.
     */
    'run/detached': RunDetachedData
    /**
     * Boot reconciliation re-adopted a run that outlived its host process.
     * @param data - durable id, kind, and the incarnation that wrote the record.
     */
    'run/resumed': RunResumedData
    /**
     * Boot reconciliation could not resume a run and settled it honestly.
     * @param data - durable id, kind, the structured reason, and its detail.
     */
    'run/abandoned': RunAbandonedData
  }
}
