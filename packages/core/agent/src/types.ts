/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm/types'

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

/**
 * Transient busy qualifier beside the two-state agent status.
 *
 * `stopping` means a requested cancellation has not converged: tool calls are
 * draining, an LLM stream is still tearing down, or the turn ending has not
 * been appended. It is the only account of the interval between asking an agent
 * to stop and its status reaching `idle`, which is otherwise indistinguishable
 * from ordinary work.
 *
 * `maintenance` means a between-turn task owns the agent (runMaintenance): a
 * manual compaction or a scheduled job may run a whole model request there. The
 * status stays `idle` because no turn is open, so this facet is what tells a
 * consumer the agent is busy and cancellable.
 */
export type AgentActivity = 'stopping' | 'maintenance'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * Live dispatch precedes projection mutation, so synchronous observers may
     * read the pre-splice inbox to recover the removed messages.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
  }
}
