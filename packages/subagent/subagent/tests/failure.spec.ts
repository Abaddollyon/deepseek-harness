import { describe, expect, it } from 'vitest'
import { LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { subagentFailureFromLlmFailure } from '../src/index.ts'
import { subagentFailureFromUnknown } from '../src/failure.ts'
import { settlementSummary } from '../src/continuation.ts'
import { terminalDiagnostic } from '../src/lifecycle.ts'

describe('subagentFailureFromLlmFailure', () => {
  it('maps quota and preserves retry delay without diagnostic text', () => {
    expect(subagentFailureFromLlmFailure({ message: 'account exhausted', code: QUOTA_EXCEEDED_CODE, status: 429, providerRetryAfterMs: 12_000 }))
      .toEqual({ code: QUOTA_EXCEEDED_CODE, retryAfterMs: 12_000 })
  })

  it('maps rate limits and leaves unknown causes absent', () => {
    expect(subagentFailureFromLlmFailure({ message: 'busy', code: 'RATE_LIMIT' })).toEqual({ code: 'RATE_LIMIT' })
    expect(subagentFailureFromLlmFailure({ message: 'failure', code: 'OTHER' })).toBeUndefined()
  })

  it('rejects malformed unknown failure fields and bounds retry delays', () => {
    expect(subagentFailureFromUnknown(null)).toBeUndefined()
    expect(subagentFailureFromUnknown({ code: 'OTHER', providerRetryAfterMs: 10 })).toBeUndefined()
    expect(subagentFailureFromUnknown({
      code: QUOTA_EXCEEDED_CODE,
      providerRetryAfterMs: Number.NaN,
    })).toEqual({ code: QUOTA_EXCEEDED_CODE })
    expect(subagentFailureFromUnknown({ code: 'RATE_LIMIT', providerRetryAfterMs: -1 })).toEqual({ code: 'RATE_LIMIT' })
    expect(subagentFailureFromUnknown({ code: 'RATE_LIMIT', providerRetryAfterMs: Number.POSITIVE_INFINITY })).toEqual({ code: 'RATE_LIMIT' })
    expect(subagentFailureFromUnknown({ code: 'RATE_LIMIT', providerRetryAfterMs: 0 })).toEqual({ code: 'RATE_LIMIT', retryAfterMs: 0 })
  })

  it('terminates on a self-referential Error cause', () => {
    const cyclic = new Error('cycle')
    Object.defineProperty(cyclic, 'cause', { value: cyclic })
    expect(terminalDiagnostic(cyclic)).toEqual({ diagnostic: 'Subagent teardown failed.' })
  })

  it('formats every parent-facing failure classification', () => {
    const quota = { code: 'QUOTA' as const }
    const rate = { code: 'RATE_LIMIT' as const, retryAfterMs: 12_000 }
    expect(settlementSummary(SessionId('child'), 'error', 'quota detail', quota)).toContain('quota for this route is exhausted')
    expect(settlementSummary(SessionId('child'), 'error', 'rate detail', rate)).toContain('wait 12 seconds before retrying')
    expect(settlementSummary(SessionId('child'), 'error', 'unknown detail', { code: 'OTHER' })).toBe('Background subagent child failed before it finished. Reason: unknown detail')
    expect(settlementSummary(SessionId('child'), 'completed', 'ignored')).toContain('finished')
    expect(settlementSummary(SessionId('child'), 'error', 'rate detail', { code: 'RATE_LIMIT' })).toContain('wait before retrying')
    expect(settlementSummary(SessionId('child'), 'error', 'rate detail', { code: 'RATE_LIMIT', retryAfterMs: 0 })).toContain('wait before retrying')
    expect(settlementSummary(SessionId('child'), 'error', 'rate detail', { code: 'RATE_LIMIT', retryAfterMs: 1_000 })).toContain('wait 1 second before retrying')
    expect(settlementSummary(SessionId('child'), 'error', 'rate detail', { code: 'RATE_LIMIT', retryAfterMs: 1_500 })).toContain('wait 1.5 seconds before retrying')
  })

  it('uses fixed teardown text and preserves typed causes across failure graphs', () => {
    const failure = Object.assign(new Error('quota detail must stay private'), { code: 'QUOTA' })
    expect(terminalDiagnostic(failure)).toEqual({
      diagnostic: 'Subagent teardown failed.',
      failure: { code: 'QUOTA' },
    })
    const nested = new LlmError('quota', QUOTA_EXCEEDED_CODE, { providerRetryAfterMs: 12_000 })
    expect(terminalDiagnostic(new Error('wrapper', { cause: nested })).failure).toEqual({
      code: QUOTA_EXCEEDED_CODE,
      retryAfterMs: 12_000,
    })
    const invalidOuter = Object.assign(new Error('wrapper', { cause: nested }), {
      failure: { code: 'OTHER' },
    })
    expect(terminalDiagnostic(invalidOuter).failure).toEqual({
      code: QUOTA_EXCEEDED_CODE,
      retryAfterMs: 12_000,
    })
    expect(terminalDiagnostic(new Error('wrapper', {
      cause: new AggregateError([new Error('generic'), nested]),
    })).failure).toEqual({ code: QUOTA_EXCEEDED_CODE, retryAfterMs: 12_000 })
    expect(terminalDiagnostic({
      failure: { code: 'RATE_LIMIT', retryAfterMs: 3_000 },
    }).failure).toEqual({ code: 'RATE_LIMIT', retryAfterMs: 3_000 })
    expect(terminalDiagnostic(undefined)).toEqual({})
    expect(terminalDiagnostic('private primitive')).toEqual({ diagnostic: 'Subagent teardown failed.' })
  })

  it('contains hostile Proxy metadata while classifying teardown facts', () => {
    const direct = new Proxy({}, {
      getOwnPropertyDescriptor(): never { throw new Error('descriptor denied') },
    })
    expect(subagentFailureFromUnknown(direct)).toBeUndefined()
    expect(terminalDiagnostic(direct)).toEqual({ diagnostic: 'Subagent teardown failed.' })

    const revoked = Proxy.revocable([], {})
    revoked.revoke()
    expect(terminalDiagnostic({ errors: revoked.proxy })).toEqual({ diagnostic: 'Subagent teardown failed.' })

    const descriptorDeniedArray = new Proxy([], {
      getOwnPropertyDescriptor(): never { throw new Error('descriptor denied') },
    })
    expect(terminalDiagnostic({ errors: descriptorDeniedArray })).toEqual({ diagnostic: 'Subagent teardown failed.' })
  })
})
