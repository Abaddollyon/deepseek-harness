/** Pure classification and pending-work policy for event-conditioned goal continuation. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { MessageSource } from '@deepseek-ai/dsh-llm'

/**
 * Decide whether a durable user message authorizes another goal continuation.
 * @param source - recorded message origin and presentation form.
 * @returns whether the message represents external progress rather than driver-owned context.
 */
export function isWakeSource(source: MessageSource): boolean {
  if (source.kind === 'user') return true
  if (source.kind === 'goal') return false
  if (source.kind === 'plugin' && source.plugin === 'tool-goal') return false
  return 'form' in source && (source.form === 'notice' || source.form === 'relay')
}

/**
 * Detect live work owned by one parent agent.
 * @param owner - agent whose goal may continue.
 * @param agents - live agent registry snapshot.
 * @param jobs - optional background-job registry.
 * @returns whether a child or job is expected to publish a future wake message.
 */
export function hasPendingWork(owner: Agent, agents: Agent[], jobs: JobRegistry | undefined): boolean {
  return agents.some(candidate =>
    candidate !== owner
    && candidate.session.header.parentSession === owner.id
    && candidate.status === 'running')
    || (jobs?.list(owner).some(job => job.status === 'running' || job.status === 'stopping') ?? false)
}
