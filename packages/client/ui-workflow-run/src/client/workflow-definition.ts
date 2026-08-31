import type {
  ConversationLocation, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-run-supervisor/types'
import type {
  ToolWorkflowAgentEndData, ToolWorkflowAgentStartData, ToolWorkflowLogData,
  ToolWorkflowPhaseData,
} from '@deepseek-ai/dsh-tool-workflow/types'
import type { WorkflowAgentOutcome, WorkflowStopReason } from '@deepseek-ai/dsh-workflow/types'

/** Status shown for a workflow, phase, or member. */
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** Final renderer data for one member. */
export interface WorkflowRunMemberData {
  readonly seq: number
  readonly label: string
  readonly childId: SessionId
  readonly status: WorkflowRunStatus
}

/** Final renderer data for one exact phase identity. */
export interface WorkflowRunPhaseData {
  readonly key: string
  /** `null` is the absent field; the empty string remains a distinct identity. */
  readonly phase: string | null
  readonly members: readonly WorkflowRunMemberData[]
}

/** Final keyed Chat payload for one workflow run. */
export interface WorkflowRunChatData {
  readonly name: string
  readonly status: WorkflowRunStatus
  readonly phases: readonly WorkflowRunPhaseData[]
  /** Durable narration, omitted for records written before progress capture. */
  readonly narration?: readonly Omit<ToolWorkflowLogData, 'runId'>[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Durable top-level workflow run and all members that actually started. */
    'workflow-run': WorkflowRunChatData
  }
}

interface WorkflowMemberState extends Omit<ToolWorkflowAgentStartData, 'runId'> {
  readonly outcome?: WorkflowAgentOutcome
}

interface WorkflowState {
  readonly name: string
  readonly stopReason?: WorkflowStopReason
  readonly detached?: boolean
  readonly members: readonly WorkflowMemberState[]
  readonly phaseTitles?: readonly string[]
  readonly narration?: readonly Omit<ToolWorkflowLogData, 'runId'>[]
}

/**
 * Build a collision-free phase key preserving absent versus empty identity.
 * @param phase - exact phase string, or null for an omitted field.
 * @returns the stable renderer key for that phase identity.
 */
export function workflowPhaseKey(phase: string | null): string {
  return phase === null ? 'missing' : `value:${phase.length}:${phase}`
}

function statusFromStopReason(stopReason: WorkflowStopReason): WorkflowRunStatus {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'error': return 'failed'
    /* v8 ignore next -- WorkflowStopReason is closed and every variant is handled above. */
    default: return stopReason satisfies never
  }
}

function statusFromOutcome(outcome: WorkflowAgentOutcome): WorkflowRunStatus {
  switch (outcome) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
    /* v8 ignore next -- WorkflowAgentOutcome is closed and every variant is handled above. */
    default: return outcome satisfies never
  }
}

function locationClosed(location: ConversationLocation): boolean {
  if (location.kind === 'step') {
    return location.step.status === 'closed' || location.turn.status === 'closed'
  }
  return location.kind === 'turn' && location.turn.status === 'closed'
}

function projectWorkflow(
  context: ConversationNodeContext<WorkflowState>,
  location: ConversationLocation,
): WorkflowRunChatData {
  const state = context.state as WorkflowState
  const interrupted = state.stopReason === undefined
    && state.detached !== true
    && locationClosed(location)
  const phases = new Map<string, { phase: string | null; members: WorkflowRunMemberData[] }>()
  for (const title of state.phaseTitles ?? []) {
    const key = workflowPhaseKey(title)
    if (!phases.has(key)) phases.set(key, { phase: title, members: [] })
  }
  for (const member of state.members) {
    const phase = member.phase === undefined ? null : member.phase
    const key = workflowPhaseKey(phase)
    let group = phases.get(key)
    if (group === undefined) {
      group = { phase, members: [] }
      phases.set(key, group)
    }
    group.members.push({
      seq: member.seq,
      label: member.label,
      childId: member.childId,
      status: member.outcome === undefined
        ? interrupted ? 'interrupted' : 'running'
        : statusFromOutcome(member.outcome),
    })
  }
  const projectedPhases = [...phases].map(([key, phase]) => ({
    key,
    phase: phase.phase,
    members: phase.members,
  }))
  return {
    name: state.name,
    status: state.stopReason === undefined
      ? interrupted ? 'interrupted' : 'running'
      : statusFromStopReason(state.stopReason),
    phases: projectedPhases,
    ...state.narration === undefined ? {} : { narration: state.narration },
  }
}

function updatePhase(state: WorkflowState, data: ToolWorkflowPhaseData): WorkflowState {
  return { ...state, phaseTitles: [...(state.phaseTitles ?? []), data.title] }
}

function updateLog(state: WorkflowState, data: ToolWorkflowLogData): WorkflowState {
  const line: Omit<ToolWorkflowLogData, 'runId'> = {
    message: data.message,
    ordinal: data.ordinal,
    ...data.truncated === undefined ? {} : { truncated: data.truncated },
  }
  return { ...state, narration: [...(state.narration ?? []), line] }
}

function updateAgentStart(state: WorkflowState, data: ToolWorkflowAgentStartData): WorkflowState {
  const member: WorkflowMemberState = {
    seq: data.seq,
    label: data.label,
    ...data.phase === undefined ? {} : { phase: data.phase },
    childId: data.childId,
  }
  return { ...state, members: [...state.members, member] }
}

function updateAgentEnd(state: WorkflowState, data: ToolWorkflowAgentEndData): WorkflowState {
  return {
    ...state,
    members: state.members.map(member => member.seq === data.seq
      ? { ...member, outcome: data.outcome }
      : member),
  }
}

/** Durable workflow event family folded into one keyed Chat node. */
export const workflowRunDefinition: ConversationNodeDefinition<WorkflowState> = {
  kind: 'workflow-run',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool-workflow/run-start') return { id: String(event.data.runId), role: 'start' }
    if (event.type === 'run/detached' && event.data.kind === 'workflow' && event.data.runId !== undefined) {
      return { id: String(event.data.runId), role: 'update' }
    }
    if (event.type === 'tool-workflow/phase'
      || event.type === 'tool-workflow/log'
      || event.type === 'tool-workflow/agent-start'
      || event.type === 'tool-workflow/agent-end'
      || event.type === 'tool-workflow/run-end') {
      return { id: String(event.data.runId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool-workflow/run-start') {
      throw new Error('workflow-run start requires tool-workflow/run-start')
    }
    return { name: match.event.data.name, members: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'run/detached') {
      return { ...context.state, detached: true }
    }
    if (match.event.type === 'tool-workflow/phase') {
      return updatePhase(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/log') {
      return updateLog(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/agent-start') {
      return updateAgentStart(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/agent-end') {
      return updateAgentEnd(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/run-end') {
      return { ...context.state, stopReason: match.event.data.stopReason }
    }
    return context.state
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    const data = projectWorkflow(context, context.start.location)
    return {
      key: context.key,
      kind: 'workflow-run',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data,
    }
  },
}
