/** Deployment-configured LLM route defaults for children started by other delegation tools. */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'

/**
 * LLM route defaults for every child a delegation tool starts. Provider and
 * model form one route and are configured together.
 */
export interface ChildRouteDefaults {
  /** LLM provider id of the child route. */
  readonly provider?: string
  /** Model id interpreted by `provider`. */
  readonly model?: string
  /** Adapter-owned reasoning effort; checked against the effective route before each child starts. */
  readonly reasoningEffort?: string
  /** Positive output-token limit per child request. */
  readonly maxTokens?: number
}

/**
 * Loader schema for an optional `agentOptions` config field holding
 * {@link ChildRouteDefaults}. The union keeps an omitted field absent instead
 * of materializing an empty object.
 */
export const childRouteDefaultsSchema: z<ChildRouteDefaults | undefined> = z.union([z.const(undefined), z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  maxTokens: z.natural().min(1),
})])

/**
 * Convert configured child route defaults into Agent options.
 * @param owner - plugin name that prefixes the configuration error.
 * @param defaults - the configured defaults, if any.
 * @returns the Agent options, or undefined when nothing is configured.
 * @throws when only one of provider and model is configured.
 */
export function childRouteAgentOptions(owner: string, defaults: ChildRouteDefaults | undefined): AgentOptions | undefined {
  if (defaults === undefined) return undefined
  if ((defaults.provider === undefined) !== (defaults.model === undefined)) {
    throw new Error(`${owner}: configure \`agentOptions.provider\` and \`agentOptions.model\` together`)
  }
  return {
    ...defaults.provider === undefined ? {} : { provider: defaults.provider },
    ...defaults.model === undefined ? {} : { model: defaults.model },
    ...defaults.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(defaults.reasoningEffort) },
    ...defaults.maxTokens === undefined ? {} : { maxTokens: defaults.maxTokens },
  }
}
