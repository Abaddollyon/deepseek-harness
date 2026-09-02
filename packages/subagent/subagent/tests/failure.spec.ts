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
    expect(terminalDiagnostic(cyclic)).toEqual({ diagnostic: 'Error: cycle' })
  })

  it('formats every parent-facing failure classification', () => {
    const quota = { code: 'QUOTA' as const }
    const rate = { code: 'RATE_LIMIT' as const, retryAfterMs: 12_000 }
    expect(settlementSummary(SessionId('child'), 'error', 'quota detail', quota)).toContain('quota for this route is exhausted')
    expect(settlementSummary(SessionId('child'), 'error', 'rate detail', rate)).toContain('wait 12 seconds before retrying')
    expect(settlementSummary(SessionId('child'), 'error', 'unknown detail', { code: 'OTHER' })).toBe('Background subagent child failed before it finished. Reason: unknown detail')
    expect(settlementSummary(SessionId('child'), 'completed', 'ignored')).toContain('finished')
    expect(settlementSummary(SessionId('child'), 'error', 'rate detail', { code: 'RATE_LIMIT' })).toContain('wait before retrying')
  })

  it('bounds lifecycle diagnostics and preserves typed causes', () => {
    const failure = Object.assign(new Error('quota detail'), { code: 'QUOTA' })
    expect(terminalDiagnostic(failure)).toEqual({ diagnostic: 'Error: quota detail', failure: { code: 'QUOTA' } })
    expect(terminalDiagnostic(Object.assign(new Error('x'.repeat(5_000)), { code: 'OTHER' })).diagnostic).toHaveLength(4096)
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
    const multibyte = terminalDiagnostic('🙂'.repeat(2_000)).diagnostic!
    expect(Buffer.byteLength(multibyte, 'utf8')).toBe(4096)
    expect(multibyte).toBe('🙂'.repeat(1_024))
    expect(terminalDiagnostic('')).toEqual({})
    expect(terminalDiagnostic({})).toEqual({ diagnostic: '[object Object]' })
    const hostile = { toString(): never { throw new Error('coercion') } }
    expect(terminalDiagnostic(hostile)).toEqual({ diagnostic: '[unprintable thrown value]' })
    const aggregate = new AggregateError([new Error('outer', { cause: new LlmError('quota', QUOTA_EXCEEDED_CODE, { providerRetryAfterMs: 1_000 }) })])
    expect(terminalDiagnostic(aggregate).failure).toEqual({ code: QUOTA_EXCEEDED_CODE, retryAfterMs: 1_000 })
    const cyclic = new AggregateError([])
    Object.defineProperty(cyclic, 'errors', { value: [cyclic] })
    expect(terminalDiagnostic(cyclic).failure).toBeUndefined()
  })
})
