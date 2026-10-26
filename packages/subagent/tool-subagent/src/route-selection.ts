/**
 * Child LLM route selection for other delegation tools: the configured
 * route defaults, the merge, allowed-route and adapter preflight rules the
 * subagent tool applies, and the Session's durable allowed-route list. A
 * consumer registers
 * `subagentModelSelectionProjectionDefinition` with `ctx.sessionProjections`
 * (the registry shares one registration per key) and reads the list through
 * the returned handle.
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
export { subagentModelSelectionPolicy, subagentModelSelectionProjectionDefinition } from './model-selection-state.ts'
