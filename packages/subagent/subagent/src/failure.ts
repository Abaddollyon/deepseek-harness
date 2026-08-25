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
  const cause = failure.code === QUOTA_EXCEEDED_CODE
    ? 'quota'
    : failure.code === 'RATE_LIMIT'
      ? 'rate-limit'
      : failure.code === 'SERVER' || failure.code === 'TIMEOUT' || failure.code === 'TRANSPORT'
        ? 'transient'
        : failure.code === 'AUTH' || failure.code === 'INVALID_CREDENTIAL' || failure.code === 'INVALID_REQUEST'
          ? 'permanent'
          : undefined
  if (cause === undefined) return undefined
  return Object.freeze({
    cause,
    ...failure.providerRetryAfterMs === undefined ? {} : { retryAfterMs: failure.providerRetryAfterMs },
  })
}
