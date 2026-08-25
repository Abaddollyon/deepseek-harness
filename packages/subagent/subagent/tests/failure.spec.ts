import { describe, expect, it } from 'vitest'
import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { subagentFailureFromLlmFailure } from '../src/index.ts'

describe('subagentFailureFromLlmFailure', () => {
  it('maps quota and preserves the provider retry delay without diagnostic text', () => {
    expect(subagentFailureFromLlmFailure({
      message: 'account exhausted', code: QUOTA_EXCEEDED_CODE, status: 429, providerRetryAfterMs: 12_000,
    })).toEqual({ cause: 'quota', retryAfterMs: 12_000 })
  })

  it.each([
    ['RATE_LIMIT', 'rate-limit'],
    ['SERVER', 'transient'],
    ['AUTH', 'permanent'],
    ['OTHER', 'unknown'],
  ] as const)('maps %s to %s', (code, cause) => {
    expect(subagentFailureFromLlmFailure({ message: 'failure', code })).toEqual({ cause })
  })
})
