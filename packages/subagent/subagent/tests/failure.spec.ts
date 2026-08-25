import { describe, expect, it } from 'vitest'
import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { subagentFailureFromLlmFailure } from '../src/index.ts'

describe('subagentFailureFromLlmFailure', () => {
  it('maps quota and preserves retry delay without diagnostic text', () => {
    expect(subagentFailureFromLlmFailure({ message: 'account exhausted', code: QUOTA_EXCEEDED_CODE, status: 429, providerRetryAfterMs: 12_000 }))
      .toEqual({ cause: 'quota', retryAfterMs: 12_000 })
  })

  it('maps rate limits and leaves unknown causes absent', () => {
    expect(subagentFailureFromLlmFailure({ message: 'busy', code: 'RATE_LIMIT' })).toEqual({ cause: 'rate-limit' })
    expect(subagentFailureFromLlmFailure({ message: 'failure', code: 'OTHER' })).toBeUndefined()
  })
})
