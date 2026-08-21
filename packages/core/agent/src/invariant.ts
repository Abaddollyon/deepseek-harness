/** Package-owned agent lifecycle invariants. @module @deepseek-ai/dsh-agent/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Agent, AgentActivity, AgentStatus } from '@deepseek-ai/dsh-agent'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent'

/** Cordis companion plugin name. */
export const name = 'agent-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Install the agent contribution into its child registration fiber. */
const install: InvariantInstaller = (ctx, fail) => {
  const lastStatus = new WeakMap<Agent, AgentStatus>()
  ctx.on('agent/status', ({ agent, status }) => {
    const previous = lastStatus.get(agent)
    if (previous === status) {
      fail(`agent/status repeated ${status} (no-op transition)`)
    }
    lastStatus.set(agent, status)
  }, { global: true })
  // The activity facet carries the same transition contract as the status it
  // qualifies, and its cleared value is a real state: an agent that has never
  // published an activity is indistinguishable from one that just cleared it,
  // so the seed is recorded on first sight rather than defaulted.
  const lastActivity = new WeakMap<Agent, { value: AgentActivity | undefined }>()
  ctx.on('agent/activity', ({ agent, activity }) => {
    const previous = lastActivity.get(agent)
    if (previous !== undefined && previous.value === activity) {
      fail(`agent/activity repeated ${String(activity)} (no-op transition)`)
    }
    lastActivity.set(agent, { value: activity })
  }, { global: true })
}

/**
 * Register the agent invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
