import process from 'node:process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  ClaudeCodeSearchProvider,
  normalizeResult,
  type ClaudeCodeSearchProviderOptions,
} from '../src/index.ts'

type Message = Record<string, unknown>
type QueryInput = {
  prompt: string
  options: {
    abortController: AbortController
    spawnClaudeCodeProcess: (options: Record<string, unknown>) => unknown
    [key: string]: unknown
  }
}
type ChildPlan = {
  terminateError?: Error
  wait?: boolean | Error
  done?: { exitCode: number | null; signal: NodeJS.Signals | null } | Error
}
type HarnessPlan = {
  messages?: readonly Message[]
  iterationError?: unknown
  queryError?: unknown
  closeError?: Error
  spawns?: number
  child?: ChildPlan
  resolve?: string | Error
  spawnError?: Error
  hang?: boolean
  executable?: string
  timeout?: number
}

const raw = (query = 'q', results: unknown[] = [
  { content: [{ url: 'https://one.test', title: 'One' }] },
]) => ({ type: 'user', tool_use_result: { query, results } })
const success = (value: unknown = {
  query: 'q',
  answer: 'grounded',
  sources: [{ url: 'https://one.test' }],
  truncated: false,
}) => ({ type: 'result', subtype: 'success', structured_output: value })

function harness(plan: HarnessPlan = {}) {
  const state = {
    inputs: [] as QueryInput[],
    spawnSpecs: [] as Record<string, unknown>[],
    terminated: 0,
    waited: 0,
    closed: 0,
    resolved: [] as string[],
  }
  const childPlan = plan.child ?? {}
  const doneValue = childPlan.done ?? { exitCode: 0, signal: null }
  const child = {
    pid: 42,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: undefined,
    collected: {},
    done: doneValue instanceof Error ? Promise.reject(doneValue) : Promise.resolve(doneValue),
    terminate: () => {
      state.terminated += 1
      if (childPlan.terminateError !== undefined) throw childPlan.terminateError
    },
    waitForExit: async () => {
      state.waited += 1
      if (childPlan.wait instanceof Error) throw childPlan.wait
      return childPlan.wait ?? true
    },
  }
  const ctx = {
    subprocess: {
      resolveExecutable: async (command: string) => {
        state.resolved.push(command)
        if (plan.resolve instanceof Error) throw plan.resolve
        return plan.resolve ?? process.execPath
      },
      spawn: (spec: Record<string, unknown>) => {
        state.spawnSpecs.push(spec)
        if (plan.spawnError !== undefined) throw plan.spawnError
        return child
      },
    },
  }
  const query = ((input: QueryInput) => {
    state.inputs.push(input)
    if (plan.queryError !== undefined) throw plan.queryError
    for (let index = 0; index < (plan.spawns ?? 1); index += 1) {
      input.options.spawnClaudeCodeProcess({
        command: 'claude', args: [], cwd: '.', env: {}, signal: undefined,
      })
    }
    const iterator = (async function* () {
      if (plan.hang === true && !input.options.abortController.signal.aborted) {
        await new Promise<void>((resolve) => {
          input.options.abortController.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
      for (const message of plan.messages ?? [raw(), success()]) yield message as never
      if (plan.iterationError !== undefined) throw plan.iterationError
    })()
    return Object.assign(iterator, {
      close: () => {
        state.closed += 1
        if (plan.closeError !== undefined) throw plan.closeError
      },
    })
  }) as never
  const options: ClaudeCodeSearchProviderOptions = {
    cwd: '.',
    requestTimeoutMs: plan.timeout ?? 100,
    disposeGraceMs: 7,
    maxResults: 8,
    maxTurns: 4,
    maxPayloadBytes: 1048,
    ...(plan.executable === undefined ? {} : { executable: plan.executable }),
    query,
  }
  return { provider: new ClaudeCodeSearchProvider(ctx as never, options), state }
}

async function failure(plan: HarnessPlan, code: string, message?: string) {
  const { provider } = harness(plan)
  const promise = provider.search({ query: 'q' })
  if (message === undefined) await expect(promise).rejects.toMatchObject({ code })
  else await expect(promise).rejects.toMatchObject({ code, message })
}

function serializeRecursively(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  const serialized: Record<string, unknown> = {}
  if (value instanceof Error) {
    serialized.name = value.name
    serialized.message = value.message
    serialized.cause = serializeRecursively(value.cause, seen)
  }
  for (const key of Object.keys(value)) {
    serialized[key] = serializeRecursively((value as Record<string, unknown>)[key], seen)
  }
  return serialized
}

describe('result normalization', () => {
  it('preserves optional fields, deduplicates, validates URLs and caps sources', () => {
    expect(normalizeResult({
      query: 'q',
      answer: 'grounded',
      truncated: false,
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'S', publishedAt: 'today' },
        { url: 'https://a.test' },
        { url: 'ftp://bad' },
        null,
        { url: 'http://b.test' },
      ],
    }, 1)).toEqual({
      content: 'grounded',
      sources: [{ url: 'https://a.test', title: 'A', snippet: 'S', publishedAt: 'today' }],
      truncated: true,
    })
    expect(normalizeResult({ query: 'q', sources: [], truncated: true })).toEqual({
      sources: [], truncated: true,
    })
  })

  it.each([
    null,
    [],
    {},
    { query: 'q', truncated: false },
    { query: 'q', sources: [], truncated: 'no' },
    { query: 'q', sources: [], truncated: false, answer: 1 },
  ])('rejects malformed structured output %#', (value) => {
    expect(() => normalizeResult(value)).toThrow('malformed structured web search data')
  })

  it('caps answers and oversized URL payloads by UTF-8 bytes', () => {
    const answer = normalizeResult({
      query: 'q', answer: '🙂'.repeat(300), sources: [], truncated: false,
    }, 8, 200)
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(200)
    expect(answer.truncated).toBe(true)
    const urls = normalizeResult({
      query: 'q', sources: [{ url: `https://example.test/${'x'.repeat(400)}` }], truncated: false,
    }, 8, 80)
    expect(urls).toEqual({ sources: [], truncated: true })
    expect(normalizeResult({ query: 'q', answer: '', sources: [], truncated: false }, 8, 20))
      .toEqual({ sources: [], truncated: true })
  })
})

describe('availability and SDK options', () => {
  it('provides synchronous default, bare, absolute and missing hints', () => {
    expect(harness().provider.available()).toBe(true)
    expect(harness({ executable: 'claude' }).provider.available()).toBe(true)
    expect(harness({ executable: '' }).provider.available()).toBe(false)
    expect(harness({ executable: process.execPath }).provider.available()).toBe(true)
    expect(harness({ executable: '/definitely/missing/claude' }).provider.available()).toBe(false)
  })

  it('uses only WebSearch, structured output, no persistence and one resolved executable', async () => {
    const { provider, state } = harness({
      executable: 'claude',
      messages: [
        { type: 'system' },
        { type: 'user' },
        raw('other'),
        raw('q', [{ url: 'https://direct.test' }, { content: [{ url: 'bad' }] }]),
        success(),
      ],
    })
    await expect(provider.search({ query: 'q' })).resolves.toMatchObject({ content: 'grounded' })
    const input = state.inputs[0]
    expect(input?.prompt).toContain('q')
    expect(input?.options).toMatchObject({
      tools: ['WebSearch'], allowedTools: ['WebSearch'], permissionMode: 'dontAsk',
      persistSession: false, maxTurns: 4, pathToClaudeCodeExecutable: process.execPath,
    })
    expect(input?.options.outputFormat).toMatchObject({ type: 'json_schema' })
    expect(state.resolved).toEqual(['claude'])
    expect(state.spawnSpecs[0]).toMatchObject({ graceMs: 7 })
    expect(state.terminated).toBe(1)
    expect(state.waited).toBe(1)
    expect(state.closed).toBe(1)
  })
})

describe('protocol classification', () => {
  it('rejects missing, duplicate, malformed and mismatched raw WebSearch results', async () => {
    await failure({ messages: [success()] }, 'WEB_PROVIDER_PROTOCOL', 'Claude Code returned no WebSearch result')
    await failure({ messages: [raw(), raw(), success()] }, 'WEB_PROVIDER_PROTOCOL', 'Claude Code returned duplicate WebSearch results')
    await failure({ messages: [raw('q', []), success()] }, 'WEB_PROVIDER_PROTOCOL', 'Claude Code returned malformed WebSearch result')
    await failure({ messages: [raw('other'), success()] }, 'WEB_PROVIDER_PROTOCOL', 'Claude Code returned no WebSearch result')
    await failure({ messages: [{ type: 'user', tool_use_result: null }, success()] }, 'WEB_PROVIDER_PROTOCOL')
  })

  it('rejects missing/duplicate results, mismatched schema, and missing/double spawn', async () => {
    await failure({ messages: [raw()] }, 'WEB_PROVIDER_PROTOCOL')
    await failure({ messages: [raw(), success(), success()] }, 'WEB_PROVIDER_PROTOCOL')
    await failure({ messages: [raw(), success({ query: 'other', sources: [], truncated: false })] }, 'WEB_PROVIDER_PROTOCOL')
    await failure({ messages: [raw(), success()], spawns: 0 }, 'WEB_PROVIDER_PROTOCOL', 'Claude Code SDK did not spawn a process')
    await failure({ spawns: 2 }, 'WEB_PROVIDER_PROTOCOL', 'Claude Code SDK attempted more than one process spawn')
    await failure({ messages: [raw(), success({ query: 'q', sources: [] })] }, 'WEB_PROVIDER_PROTOCOL')
  })

  it('classifies every non-success subtype as provider failure except stable auth evidence', async () => {
    for (const subtype of [
      'error_during_execution', 'error_max_turns', 'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]) {
      await failure({ messages: [{ type: 'result', subtype }] }, 'WEB_PROVIDER_ERROR')
    }
    for (const marker of [
      { errorClass: 'signed_out' },
      { code: 'unauthenticated' },
      { status: 'authentication_required' },
      { reason: 'login_required' },
      { terminal_reason: 'not_logged_in' },
      { errors: [' Authentication required. '] },
    ]) {
      await failure({ messages: [{ type: 'result', subtype: 'error_during_execution', ...marker }] }, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    await failure({ messages: [{ type: 'result', subtype: 'error_during_execution', errors: ['please log in to continue'] }] }, 'WEB_PROVIDER_ERROR')
  })
})

describe('execution failures and cleanup', () => {
  it('classifies stable thrown auth and missing executable evidence without exposing it', async () => {
    await failure({ queryError: new Error('not logged in') }, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    await failure({ queryError: Object.assign(new Error('hidden path'), { errorClass: 'executable_not_found' }) }, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    await failure({ queryError: new Error('Native CLI binary for linux-x64 not found. reinstall') }, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    await failure({ queryError: new Error('Claude Code executable not found') }, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    await failure({ queryError: new Error('please log in to continue') }, 'WEB_PROVIDER_ERROR')
    await failure({ queryError: 'plain failure' }, 'WEB_PROVIDER_ERROR')
  })

  it('never serializes raw resolver or SDK failure details through public causes', async () => {
    const secret = 'Bearer review-secret at /private/provider/auth.json'
    for (const plan of [
      { executable: 'claude', resolve: Object.assign(new Error(secret), { stderr: secret, cause: new Error(secret) }) },
      { executable: 'claude', resolve: new WebError(secret, 'WEB_PROVIDER_ERROR', { cause: new Error(secret) }) },
      { iterationError: Object.assign(new Error(secret), { stderr: secret, cause: new Error(secret) }) },
      { closeError: Object.assign(new Error(secret), { stderr: secret, cause: new Error(secret) }) },
    ]) {
      try {
        await harness(plan).provider.search({ query: 'q' })
        expect.unreachable('search must reject')
      } catch (error) {
        const serialized = JSON.stringify(serializeRecursively(error))
        expect(serialized).not.toContain('review-secret')
        expect(serialized).not.toContain('/private/provider/auth.json')
        expect(error).not.toHaveProperty('cause')
      }
    }
  })

  it('classifies resolution, spawn, iteration, cwd and exit failures', async () => {
    await failure({ executable: 'claude', resolve: Object.assign(new Error('x'), { code: 'ENOENT' }) }, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    await failure({ executable: 'claude', resolve: new Error('resolver failed') }, 'WEB_PROVIDER_ERROR')
    await failure({ spawnError: Object.assign(new Error('spawn'), { code: 'ENOENT' }) }, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    await failure({ spawnError: new Error('spawn failed') }, 'WEB_PROVIDER_ERROR')
    await failure({ iterationError: new Error('stream failed') }, 'WEB_PROVIDER_ERROR')
    const fileCwd = new ClaudeCodeSearchProvider({ subprocess: {} } as never, {
      cwd: import.meta.filename,
      requestTimeoutMs: 10,
      disposeGraceMs: 1,
      maxResults: 1,
      maxTurns: 1,
      maxPayloadBytes: 1048,
      query: () => { throw new Error('unreachable') },
    })
    await expect(fileCwd.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_INVALID_CONFIG' })
    await failure({ child: { done: { exitCode: 9, signal: null } } }, 'WEB_PROVIDER_ERROR', 'Claude Code web search cleanup failed')
    await failure({ child: { done: { exitCode: null, signal: 'SIGTERM' } } }, 'WEB_PROVIDER_ERROR')
  })

  it('reports close, terminate, wait and done cleanup failures only without a primary error', async () => {
    await failure({ closeError: new Error('close') }, 'WEB_PROVIDER_ERROR', 'Claude Code web search cleanup failed')
    await failure({ child: { terminateError: new Error('terminate') } }, 'WEB_PROVIDER_ERROR')
    await failure({ child: { wait: false } }, 'WEB_PROVIDER_ERROR')
    await failure({ child: { wait: new Error('wait') } }, 'WEB_PROVIDER_ERROR')
    await failure({ child: { done: new Error('done') } }, 'WEB_PROVIDER_ERROR')
    await failure({ messages: [success()], closeError: new Error('close'), child: { terminateError: new Error('terminate'), wait: new Error('wait'), done: new Error('done') } }, 'WEB_PROVIDER_PROTOCOL')
    await failure({ messages: [success()], child: { terminateError: new Error('terminate') } }, 'WEB_PROVIDER_PROTOCOL')
  })
})

describe('cancellation and disposal', () => {
  it('distinguishes caller cancellation and timeout, including their race', async () => {
    const pre = new AbortController()
    pre.abort('already')
    await expect(harness({ hang: true }).provider.search({ query: 'q' }, pre.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })

    const caller = new AbortController()
    const callerSearch = harness({ hang: true, timeout: 100 }).provider.search({ query: 'q' }, caller.signal)
    caller.abort()
    await expect(callerSearch).rejects.toMatchObject({ code: 'WEB_ABORTED' })

    await expect(harness({ hang: true, timeout: 1 }).provider.search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: 'Claude Code web search timed out after 1 ms' })

    const timeoutFirst = new AbortController()
    const raced = harness({ hang: true, timeout: 1 }).provider.search({ query: 'q' }, timeoutFirst.signal)
    const racedAssertion = expect(raced).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await new Promise(resolve => setTimeout(resolve, 5))
    timeoutFirst.abort()
    await racedAssertion
  })

  it('disposal aborts all in-flight searches and waits for zero children', async () => {
    const { provider, state } = harness({ hang: true, timeout: 1000 })
    const first = provider.search({ query: 'q' })
    const second = provider.search({ query: 'q' })
    await vi.waitFor(() => { expect(state.inputs).toHaveLength(2) })
    await provider.dispose()
    await expect(first).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    await expect(second).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(state.terminated).toBe(2)
    await provider.dispose()
  })
})
