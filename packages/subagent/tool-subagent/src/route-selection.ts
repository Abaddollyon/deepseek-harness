/**
 * Child LLM route selection for other delegation tools: the merge,
 * allowed-route and adapter preflight rules the subagent tool applies, and
 * the Session's durable allowed-route list.
 * @module @deepseek-ai/dsh-tool-subagent/route-selection
 */

export {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.ts'
export type { AllowedModelRoute, DelegationModelRequest, ModelSelectionPolicy } from './model-selection.ts'
export { subagentModelSelectionPolicy } from './model-selection-state.ts'
