/** Provider-failure mapping shared by one-shot and out-of-process subagent consumers.
 *
 * @module @deepseek-ai/dsh-subagent/failure
 */

import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { SubagentFailure } from './types.ts'

/** Read an own data property without invoking accessors or inherited values. */
export function ownDataProperty(object: object, key: PropertyKey): unknown {
  return Object.getOwnPropertyDescriptor(object, key)?.value
}

/**
 * Map a failure code and optional retry delay to subagent facts.
 * @param code - provider failure code.
 * @param providerRetryAfterMs - provider-requested retry delay.
 * @returns classified facts when the code is quota or rate limit.
 */
function mapFailure(code: unknown, providerRetryAfterMs: unknown): SubagentFailure | undefined {
  if (code !== QUOTA_EXCEEDED_CODE && code !== 'RATE_LIMIT') return undefined
  return Object.freeze({
    code,
    ...typeof providerRetryAfterMs === 'number' && Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs >= 0
      ? { retryAfterMs: providerRetryAfterMs }
      : {},
  })
}

/**
 * Map an unknown thrown or process value after validating its routing fields.
 * @param value - unknown value from an error, process, or transport boundary.
 * @returns known routing facts, or undefined when the value is not classified.
 */
export function subagentFailureFromUnknown(value: unknown): SubagentFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return mapFailure(ownDataProperty(value, 'code'), ownDataProperty(value, 'providerRetryAfterMs'))
}

/**
 * Map an LLM failure to typed facts exposed on a child result.
 * @param failure - structured failure emitted by the agent/request-error path.
 * @returns known routing facts, or undefined when the code is unclassified.
 */
export function subagentFailureFromLlmFailure(failure: LlmFailure): SubagentFailure | undefined {
  return mapFailure(failure.code, failure.providerRetryAfterMs)
}
