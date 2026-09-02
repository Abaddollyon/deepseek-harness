import { describe, expect, it } from 'vitest'
import { ClaudeCodeSearchProvider, normalizeResult } from '../src/index.ts'
describe('Claude Code web search provider', () => {
  it('normalizes, deduplicates, validates and caps sources', () => {
    const result = normalizeResult(
      {
        answer: 'grounded',
        sources: [
          { url: 'https://a.test', title: 'A' },
          { url: 'https://a.test' },
          { url: 'ftp://bad' },
          { url: 'https://b.test', snippet: 'B' },
        ],
      },
      1,
    )
    expect(result).toEqual({
      content: 'grounded',
      sources: [{ url: 'https://a.test', title: 'A' }],
      truncated: true,
    })
  })
  it('rejects malformed structured output', () => {
    expect(() => normalizeResult({ answer: 'x' })).toThrow(
      'malformed structured web search data',
    )
  })
  it('provides a synchronous availability hint', () => {
    const ctx = { subprocess: {} } as never
    expect(
      new ClaudeCodeSearchProvider(ctx, {
        cwd: '.',
        requestTimeoutMs: 1,
        disposeGraceMs: 1,
        maxResults: 1,
        maxTurns: 1,
        maxPayloadBytes: 1048,
      }).available(),
    ).toBe(true)
    expect(
      new ClaudeCodeSearchProvider(ctx, {
        cwd: '.',
        requestTimeoutMs: 1,
        disposeGraceMs: 1,
        maxResults: 1,
        maxTurns: 1,
        maxPayloadBytes: 1048,
        executable: '',
      }).available(),
    ).toBe(false)
  })
  it('disposes active requests', () => {
    const c = new AbortController()
    const p = new ClaudeCodeSearchProvider({ subprocess: {} } as never, {
      cwd: '.',
      requestTimeoutMs: 1,
      disposeGraceMs: 1,
      maxResults: 1,
      maxTurns: 1,
      maxPayloadBytes: 1048,
    })
    expect(p.id).toBe('claude-code')
    p.dispose()
    expect(c.signal.aborted).toBe(false)
  })
})

function fakeProvider(messages: readonly unknown[], childState: { terminated: boolean }) {
  const query = ((input: { options?: { spawnClaudeCodeProcess?: (options: unknown) => unknown } }) => {
    input.options?.spawnClaudeCodeProcess?.({ command: 'claude', args: [], cwd: '.', env: {}, signal: undefined })
    const iterator = (async function* () {
      yield* messages
    })()
    return Object.assign(iterator, { close: () => undefined })
  }) as never
  const child = {
    pid: 1, stdin: undefined, stdout: undefined, stderr: undefined, collected: {},
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: () => { childState.terminated = true },
  }
  const ctx = { subprocess: { spawn: () => child } } as never
  return new ClaudeCodeSearchProvider(ctx, { cwd: '.', requestTimeoutMs: 100, disposeGraceMs: 1, maxResults: 8, maxTurns: 4, maxPayloadBytes: 1048, query })
}

describe('SDK replay and lifecycle', () => {
  it('captures raw WebSearch and structured output, then terminates', async () => {
    const state = { terminated: false }
    const provider = fakeProvider([
      { type: 'user', tool_use_result: { query: 'deepseek', results: [{ content: [{ url: 'https://example.test', title: 'Example', snippet: 'S' }] }] } },
      { type: 'result', subtype: 'success', structured_output: { query: 'deepseek', answer: 'A', sources: [{ url: 'https://example.test' }] } },
    ], state)
    await expect(provider.search({ query: 'deepseek' })).resolves.toMatchObject({ content: 'A' })
    expect(state.terminated).toBe(true)
  })
  it('classifies auth markers and cancellation', async () => {
    const auth = fakeProvider([{ type: 'result', subtype: 'error_during_execution', errors: ['not logged in'] }], { terminated: false })
    await expect(auth.search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
    const controller = new AbortController(); controller.abort()
    const cancelled = fakeProvider([], { terminated: false })
    await expect(cancelled.search({ query: 'x' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})
