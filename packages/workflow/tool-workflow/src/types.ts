/**
 * Browser-safe durable workflow-record events written by the model-facing
 * workflow tool into its calling parent Session.
 *
 * @module @deepseek-ai/dsh-tool-workflow/types
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkflowAgentOutcome, WorkflowRunId, WorkflowStopReason,
} from '@deepseek-ai/dsh-workflow/types'

/** Opens one durable workflow run record. */
export interface ToolWorkflowRunStartData {
  readonly runId: WorkflowRunId
  readonly name: string
  /** Root model call enclosing a nested transport dispatch. */
  readonly parentCallId?: ToolCallId
}

/** Records one workflow phase announcement. */
export interface ToolWorkflowPhaseData {
  readonly runId: WorkflowRunId
  readonly title: string
  readonly ordinal: number
}

/** Records one workflow narration line. */
export interface ToolWorkflowLogData {
  readonly runId: WorkflowRunId
  readonly message: string
  readonly ordinal: number
  /** Whether this line was clipped or the durable progress budget ended here. */
  readonly truncated?: true
}

/** Records one workflow member after its child Session is published. */
export interface ToolWorkflowAgentStartData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: SessionId
}

/** Settles one previously started workflow member. */
export interface ToolWorkflowAgentEndData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly outcome: WorkflowAgentOutcome
}

/** Settles one workflow run after its live resources reach quiescence. */
export interface ToolWorkflowRunEndData {
  readonly runId: WorkflowRunId
  readonly stopReason: WorkflowStopReason
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one workflow record.
     * @param data - stable run identity, display name, and optional enclosing call.
     */
    'tool-workflow/run-start': ToolWorkflowRunStartData
    /**
     * Records one durable workflow phase announcement.
     * @param data - run identity, phase title, and progress ordinal.
     */
    'tool-workflow/phase': ToolWorkflowPhaseData
    /**
     * Records one durable workflow narration line.
     * @param data - run identity, narration, progress ordinal, and clipping marker.
     */
    'tool-workflow/log': ToolWorkflowLogData
    /**
     * Records one published workflow member.
     * @param data - run identity, member sequence, display identity, and child Session.
     */
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    /**
     * Records one member settlement.
     * @param data - run identity, paired member sequence, and outcome.
     */
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    /**
     * Closes one workflow record after cleanup.
     * @param data - stable run identity and terminal reason.
     */
    'tool-workflow/run-end': ToolWorkflowRunEndData
  }
}
