/** Provider-failure mapping shared by one-shot and out-of-process subagent consumers.
 *
 * @module @deepseek-ai/dsh-subagent/failure
 */

import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { SubagentFailure } from './types.ts'

/**
 * Map an LLM failure to typed facts exposed on a child result.
 * @param failure - structured failure emitted by the agent/request-error path.
 * @returns known routing facts, or undefined when the code is unclassified.
 */
export function subagentFailureFromLlmFailure(failure: LlmFailure): SubagentFailure | undefined {
  if (failure.code !== QUOTA_EXCEEDED_CODE && failure.code !== 'RATE_LIMIT') return undefined
  return Object.freeze({
    code: failure.code,
    ...failure.providerRetryAfterMs === undefined ? {} : { retryAfterMs: failure.providerRetryAfterMs },
  })
}
