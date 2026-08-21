import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AgentInvariant)
  return ctx
}

function mockAgent(id: string): Agent {
  return { id } as unknown as Agent
}

describe('agent status invariants', () => {
  it('accepts lifecycle transitions between idle and running', async () => {
    const ctx = await setup()
    const agent = mockAgent('a1')
    expect(() => {
      ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'idle' })
      ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'running' })
      ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'idle' })
    }).not.toThrow()
  })

  it('rejects a no-op transition', async () => {
    const ctx = await setup()
    const agent = mockAgent('a3')
    ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'running' })
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/status', { agent, status: 'running' }) })
      .toThrow(/no-op transition/)
  })

  it('accepts activity transitions and rejects a repeated one', async () => {
    const ctx = await setup()
    const agent = mockAgent('a7')
    expect(() => {
      ctx.emit(scopeTarget(agent, agent), 'agent/activity', { agent, activity: 'maintenance' })
      ctx.emit(scopeTarget(agent, agent), 'agent/activity', { agent, activity: 'stopping' })
      ctx.emit(scopeTarget(agent, agent), 'agent/activity', { agent, activity: undefined })
    }).not.toThrow()
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/activity', { agent, activity: undefined }) })
      .toThrow(/no-op transition/)
  })

  it('records a first cleared activity instead of defaulting it', async () => {
    const ctx = await setup()
    const agent = mockAgent('a8')
    // A never-published facet is not the same fact as a just-cleared one, so
    // the first emission is a transition even when its value is undefined.
    expect(() => { ctx.emit(scopeTarget(agent, agent), 'agent/activity', { agent, activity: undefined }) })
      .not.toThrow()
  })

  it('tracks agents independently', async () => {
    const ctx = await setup()
    const a = mockAgent('a5')
    const b = mockAgent('b5')
    ctx.emit(scopeTarget(a, a), 'agent/status', { agent: a, status: 'running' })
    expect(() => { ctx.emit(scopeTarget(b, b), 'agent/status', { agent: b, status: 'running' }) }).not.toThrow()
  })
})
