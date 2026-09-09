import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentBudget } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

function response(chunks: StreamChunk[], usage = { inputTokens: 4, outputTokens: 2 }): StreamChunk[] {
  return [...chunks, { type: 'usage', usage }, { type: 'finish', reason: { kind: chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call') ? 'tool-calls' : 'stop' } }]
}

function text(text: string, usage?: { inputTokens: number; outputTokens: number }): StreamChunk[] {
  return response([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ], usage)
}

function tool(id: string): StreamChunk[] {
  const callId = ToolCallId(id)
  return response([
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'again', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'again', arguments: '{}' } },
  ])
}

class BudgetAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: StreamChunk[][],
    private readonly count: ((request: GenerateOptions) => number) | null = () => 4,
  ) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override countInputTokens(request: GenerateOptions): number | undefined {
    return this.count?.(request)
  }

  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('budget adapter script exhausted')
    yield* chunks
  }
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(adapter: BudgetAdapter): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['budget'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'again', description: 'continue', parameters: {}, execute: async () => [{ type: 'text', text: 'continue' }],
  }))
  return ctx
}

function send(agent: Agent): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
}

function budget(overrides: Partial<AgentBudget> = {}): AgentBudget {
  return { maxTurns: 3, maxInputTokens: 20, maxOutputTokens: 8, maxRetries: 0, ...overrides }
}

function finalReason(agent: Agent) {
  const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  return end?.type === 'turn/end' ? end.data.reason : undefined
}

describe('native agent budgets', () => {
  it('snapshots execution limits while preserving the public options identity', async () => {
    const adapter = new BudgetAdapter([tool('one'), text('unused')])
    const ctx = await harness(adapter)
    const configuredBudget = budget({ maxTurns: 1 })
    const agent = await ctx.agentLoop.create(SessionId('immutable-budget'), {
      provider: 'budget', model: 'model', budget: configuredBudget,
    })
    expect(agent.options.budget).toBe(configuredBudget)

    configuredBudget.maxTurns = 2
    configuredBudget.maxInputTokens = 200
    configuredBudget.maxOutputTokens = 80
    configuredBudget.maxRetries = 20
    send(agent)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(finalReason(agent)).toMatchObject({ kind: 'error', error: { code: 'BUDGET_EXCEEDED' } })
  })

  it.each([
    { maxTurns: 0 }, { maxInputTokens: 0 }, { maxOutputTokens: 0 }, { maxRetries: -1 },
    { maxTurns: 1.5 }, { maxInputTokens: Number.POSITIVE_INFINITY }, { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid budget before publication: $maxTurns $maxInputTokens $maxOutputTokens $maxRetries', async (invalid) => {
    const ctx = await harness(new BudgetAdapter([]))
    await expect(ctx.agentLoop.create(SessionId('invalid'), {
      provider: 'budget', model: 'model', budget: { ...budget(), ...invalid },
    })).rejects.toThrow(/agent budget/)
    expect(ctx.agents.list()).toEqual([])
  })

  it('limits model steps and stops before an excess request dispatch', async () => {
    const adapter = new BudgetAdapter([tool('one'), text('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('turns'), {
      provider: 'budget', model: 'model', budget: budget({ maxTurns: 1 }),
    })
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(finalReason(agent)).toMatchObject({ kind: 'error', error: { code: 'BUDGET_EXCEEDED' } })
  })

  it('clamps each request to the remaining total output budget', async () => {
    const adapter = new BudgetAdapter([tool('one'), text('done', { inputTokens: 4, outputTokens: 3 })])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('output'), {
      provider: 'budget', model: 'model', maxTokens: 99, budget: budget({ maxOutputTokens: 5 }),
    })
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests.map(request => request.maxTokens)).toEqual([5, 3])
    expect(finalReason(agent)).toMatchObject({ kind: 'completed' })
  })

  it('uses authoritative response usage and stops before the next request at the input threshold', async () => {
    const adapter = new BudgetAdapter([tool('one'), text('unused')], null)
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('response-input'), {
      provider: 'budget', model: 'model', budget: budget({ maxInputTokens: 4 }),
    })
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(finalReason(agent)).toMatchObject({ kind: 'error', error: { code: 'BUDGET_EXCEEDED' } })
  })

  it('continues with response accounting when an adapter has no exact input counter', async () => {
    const adapter = new BudgetAdapter([tool('one'), text('done', { inputTokens: 4, outputTokens: 2 })], null)
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('response-accounted-input'), {
      provider: 'budget', model: 'model', budget: budget({ maxInputTokens: 9 }),
    })
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(finalReason(agent)).toMatchObject({ kind: 'completed' })
  })

  it('stops further requests when a response omits usage and no exact count was available', async () => {
    const withoutUsage = tool('one').filter(chunk => chunk.type !== 'usage')
    const adapter = new BudgetAdapter([withoutUsage, text('unused')], null)
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('unknown-input'), {
      provider: 'budget', model: 'model', budget: budget(),
    })
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(finalReason(agent)).toMatchObject({ kind: 'error', error: { code: 'BUDGET_ACCOUNTING_UNAVAILABLE' } })
  })

  it('stops before a request whose exact input count exceeds the remaining total', async () => {
    const adapter = new BudgetAdapter([tool('one'), text('unused')], () => 4)
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('input'), {
      provider: 'budget', model: 'model', budget: budget({ maxInputTokens: 7 }),
    })
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(finalReason(agent)).toMatchObject({ kind: 'error', error: { code: 'BUDGET_EXCEEDED' } })
  })

  it('reports a provider output overshoot instead of treating it as compliant', async () => {
    const adapter = new BudgetAdapter([text('too much', { inputTokens: 4, outputTokens: 6 })])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('output-overshoot'), {
      provider: 'budget', model: 'model', budget: budget({ maxOutputTokens: 5 }),
    })
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(finalReason(agent)).toMatchObject({ kind: 'error', error: { code: 'BUDGET_EXCEEDED' } })
  })

  it('allows only the configured number of request-error retries', async () => {
    const failure: StreamChunk[] = [
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'retry me' } } },
    ]
    const adapter = new BudgetAdapter([failure, failure, text('unused')])
    const ctx = await harness(adapter)
    ctx.on('agent/request-error', async () => ({ kind: 'retry' as const }))
    const agent = await ctx.agentLoop.create(SessionId('retries'), {
      provider: 'budget', model: 'model', budget: budget({ maxRetries: 1 }),
    })
    send(agent)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(finalReason(agent)).toMatchObject({ kind: 'error', error: { code: 'BUDGET_EXCEEDED' } })
  })
})
