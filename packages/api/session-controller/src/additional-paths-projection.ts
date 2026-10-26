/** Client-visible projection of the additional workspace roots a Session recorded at creation. */

import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const additionalPathsSchema: z.ZodType<readonly string[] | null> = z.array(z.string()).nullable()

const additionalPathsProjection = {
  key: 'additionalPaths',
  stateSchema: additionalPathsSchema,
  init: () => null,
  apply: (state, event) => event.type === 'workspace/roots' ? event.data.additionalPaths : state,
  wire: { viewSchema: additionalPathsSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'additionalPaths', readonly string[] | null>

/**
 * Register the Session additional-root projection on the calling fiber.
 * @param ctx - Session Controller context.
 * @returns when the registration is ready, before consumers are published.
 */
export async function installAdditionalPathsProjection(ctx: Context): Promise<void> {
  await ctx.sessionProjections.register(additionalPathsProjection)
}
