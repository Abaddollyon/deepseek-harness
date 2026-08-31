/**
 * Loader fixture that holds a background child until its parent's spawn turn
 * ends, so the settlement notice can only arrive at an idle parent.
 * @module subagent-settlement-fence
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-loop'

/** Fixture plugin name. */
export const name = 'subagent-settlement-fence'

/**
 * Keep replay scheduling from folding the settlement notice into the parent's
 * spawn turn: the manager's notice races whatever the parent is doing when the
 * child's Activation ends, and this transcript pins it as the parent's own
 * later turn. Holding the child's steps until the parent's first turn closes
 * costs nothing in the parent, whose turn never awaits child model work.
 * @param ctx - assembled snapshot-agent context.
 */
export function apply(ctx: Context): void {
  const parentTurnClosed = Promise.withResolvers<undefined>()
  ctx.effect(() => {
    const disposeSession = ctx.root.on('session/event', (session, event) => {
      if (session.header.parentSession !== undefined || event.type !== 'turn/end' || event.data.turn !== 1) return
      parentTurnClosed.resolve(undefined)
    })
    const disposeStep = ctx.root.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.session.header.parentSession !== undefined) await parentTurnClosed.promise
      return next()
    })
    return () => {
      parentTurnClosed.resolve(undefined)
      disposeStep()
      disposeSession()
    }
  }, 'subagent-settlement-fence.listeners')
}
