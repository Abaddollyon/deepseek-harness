/** Loader-resolved deterministic provider for the failure composition fixture. */

import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'scripted-subagent-provider'
export const inject = ['subagents']

/** Register one deterministic provider on the shipping subagent registry. */
export function apply(ctx, config) {
  ctx.subagents.registerProvider({
    name: config.name,
    capabilities: {
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    },
    inheritsParentContext: false,
    async start(request) {
      return {
        id: SessionId(`scripted-subagent:${config.name}:${request.parent.id}`),
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text: config.reply }],
          diagnostic: config.diagnostic,
          failure: config.failure,
          stopReason: config.stopReason,
        }),
        dispose: () => Promise.resolve(),
      }
    },
  })
}
