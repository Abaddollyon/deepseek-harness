/**
 * Child LLM route selection for other delegation tools: the configured
 * route defaults and the merge, allowed-route and adapter preflight rules the
 * subagent tool applies. The current Host allowlist is read at each call
 * through `ctx.subagentModelSelection.allowedRoutes()` (mount
 * `@deepseek-ai/dsh-tool-subagent/model-selection-settings`); it returns
 * `undefined` when the setting is off, and
 * {@link assertAllowedModelSelection} then permits only the parent route.
 * @module @deepseek-ai/dsh-tool-subagent/route-selection
 */

export { childRouteAgentOptions, childRouteDefaultsSchema } from './child-route-defaults.ts'
export type { ChildRouteDefaults } from './child-route-defaults.ts'
export {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.ts'
export type { AllowedModelRoute, DelegationModelRequest, ModelSelectionPolicy } from './model-selection.ts'
export type { SubagentModelSelectionConfig } from './model-selection-settings.ts'
