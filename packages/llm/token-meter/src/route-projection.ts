/**
 * Pure fold for the resolved model route of one session.
 *
 * `request/context` is the durable record the agent loop appends whenever the
 * provider, model, or advertised capacity differs from the previous request's,
 * and each such event carries the complete post-change route. Last-wins over
 * that single event type is therefore the whole fold, and replaying a log
 * prefix in `seq` order reproduces the same value as the live drive.
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ModelRouteProjection } from './projection.ts'

// Cast for the optional value: under exactOptionalPropertyTypes zod infers
// `number | undefined` where the interface declares an absent-or-number field.
const routeSchema = z.object({
  provider: z.string(),
  model: z.string(),
  contextWindow: z.number().int().positive().optional(),
}).strict().nullable() as unknown as z.ZodType<ModelRouteProjection | null>

/** Whole-value equality across the three published route fields. */
const routeEquals = (left: ModelRouteProjection, right: ModelRouteProjection): boolean =>
  left.provider === right.provider
  && left.model === right.model
  && left.contextWindow === right.contextWindow

/**
 * Token-meter's model-route projection unit.
 *
 * The unit reports the route the log records and recognizes no provider,
 * model, or capacity of its own, so every adapter is described by the same
 * three fields. `null` means no request has resolved a route yet; nothing
 * substitutes a placeholder for it. A repeated identical record returns the
 * same state reference, so a log that re-states an unchanged route produces no
 * change-feed emission.
 */
export const modelRouteProjectionDefinition = {
  key: 'modelRoute',
  stateSchema: routeSchema,
  init: () => null,
  apply: (state, event) => {
    if (event.type !== 'request/context') return state
    const { provider, model, contextWindow } = event.data
    const next: ModelRouteProjection = {
      provider,
      model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    return state !== null && routeEquals(state, next) ? state : next
  },
  wire: {
    viewSchema: routeSchema,
    view: state => state,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'modelRoute', ModelRouteProjection | null> & {
  wire: NonNullable<ProjectionDefinition<'modelRoute', ModelRouteProjection | null>['wire']>
}
