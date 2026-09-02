import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

class CapacityAdapter extends MockAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_024 },
    })
  }
}

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function replacement(text: string) {
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { kind: 'plugin' as const, plugin: 'request-preflight-test' },
  })
}

describe('agent/request-preflight', () => {
  it('redispatches from a committed replacement before deriving the model request', async () => {
    const adapter = new CapacityAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('request-preflight-replace'), {
      provider: 'mock',
      model: 'mock',
    })
    const attempts: number[] = []
    ctx.on('agent/request-preflight', async (payload, next) => {
      attempts.push(payload.attempt)
      expect(payload.maxAttempts).toBe(8)
      expect(payload.contextWindow).toBe(1_024)
      expect(Object.isFrozen(payload.header)).toBe(true)
      expect(Object.isFrozen(payload.header.config)).toBe(true)
      if (payload.attempt !== 1) return next()
      const head = payload.agent.session.surface.nodes[0]!
      payload.agent.session.append('user/message', replacement('checkpoint'), {
        surfaceOp: { op: 'replace', start: head, end: head },
        sourceEventSeqs: [head],
      })
      return {
        kind: 'retry',
        surfaceGeneration: payload.agent.session.surface.replaceGeneration,
      }
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'original durable input' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(attempts).toEqual([1, 2])
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('checkpoint')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('original durable input')
  })

  it('rejects a retry justified only by log growth', async () => {
    const adapter = new CapacityAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('request-preflight-log-only'), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.on('agent/request-preflight', async ({ agent: subject, header }) => {
      subject.session.append('request/context', {
        provider: header.config.provider,
        model: header.config.model,
        contextWindow: 1_024,
      })
      return {
        kind: 'retry',
        surfaceGeneration: subject.session.surface.replaceGeneration,
      }
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
  })

  it('admits after the fixed ceiling even when every retry is productive', async () => {
    const adapter = new CapacityAdapter([textResponse('bounded')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('request-preflight-bound'), {
      provider: 'mock',
      model: 'mock',
    })
    const attempts: number[] = []
    ctx.on('agent/request-preflight', async ({ agent: subject, attempt }) => {
      attempts.push(attempt)
      const head = subject.session.surface.nodes[0]!
      subject.session.append('user/message', replacement(`replacement ${attempt}`), {
        surfaceOp: { op: 'replace', start: head, end: head },
        sourceEventSeqs: [head],
      })
      return {
        kind: 'retry',
        surfaceGeneration: subject.session.surface.replaceGeneration,
      }
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('replacement 8')
  })
})
