/**
 * Tests for the `AgentActivity` facet: the live qualifier that reports the
 * interval between a requested cancellation and its convergence (`stopping`),
 * and a between-turn task running under an `idle` status (`maintenance`).
 * Both windows are invisible to `AgentStatus` alone.
 * @module dsh-agent-loop/tests/activity
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent, type AgentActivity } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** One ordered trace of both facets, so their relative publication order is assertable. */
function traceFacets(ctx: Context, agent: Agent): string[] {
  const trace: string[] = []
  ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent) trace.push(`status:${status}`)
  })
  ctx.on('agent/activity', ({ agent: subject, activity }) => {
    if (subject === agent) trace.push(`activity:${String(activity)}`)
  })
  return trace
}

describe('agent activity facet', () => {
  it('reports stopping while a started tool call drains, and clears it before the turn retires', async () => {
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const adapter = new MockAdapter([toolCallResponse('c1', 'slow', {}), textResponse('unreached')])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'slow',
      description: 'settles only when released',
      parameters: {},
      async execute() {
        entered.resolve(undefined)
        await release.promise
        return [{ type: 'text', text: 'late' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('stopping-tool'), { provider: 'mock', model: 'mock' })
    const trace = traceFacets(ctx, agent)

    send(agent, 'call the slow tool')
    await entered.promise
    expect(agent.activity).toBeUndefined()

    agent.cancel({ kind: 'user' }, { keepInbox: true })

    // The abort has latched but the started body is still draining: the status
    // cannot say this, and the facet is published synchronously with the ask.
    expect(agent.status).toBe('running')
    expect(agent.activity).toBe('stopping')
    expect(trace).toContain('activity:stopping')

    release.resolve(undefined)
    await waitForIdle(ctx, agent)
    expect(agent.activity).toBeUndefined()
    expect(agent.status).toBe('idle')
    // Cleared BEFORE the status retires: no observer sees an idle agent that
    // still claims to be stopping.
    expect(trace).toEqual(['status:running', 'activity:stopping', 'activity:undefined', 'status:idle'])
  })

  it('reports stopping while an aborted model stream tears down', async () => {
    const adapter = new MockAdapter(['hang-slow'])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('stopping-stream'), { provider: 'mock', model: 'mock' })

    send(agent, 'stream something')
    await new Promise(resolve => setTimeout(resolve, 0))
    agent.cancel({ kind: 'user' }, { keepInbox: true })

    expect(agent.activity).toBe('stopping')
    await waitForIdle(ctx, agent)
    expect(agent.activity).toBeUndefined()
  })

  it('reports maintenance under an idle status, and a cancel during it as stopping', async () => {
    const release = Promise.withResolvers<undefined>()
    const ctx = await harness(new MockAdapter([]))
    const agent = ctx.agentLoop.create(SessionId('maintenance-facet'), { provider: 'mock', model: 'mock' })
    const trace = traceFacets(ctx, agent)

    let observed: { status: string; activity: AgentActivity | undefined } | undefined
    const maintenance = agent.runMaintenance(async (signal) => {
      // A manual compaction runs a whole model request here while the status
      // stays idle; without the facet a Stop control has nothing to render.
      observed = { status: agent.status, activity: agent.activity }
      await release.promise
      return signal.aborted
    })

    expect(observed).toEqual({ status: 'idle', activity: 'maintenance' })
    expect(trace).toEqual(['activity:maintenance'])

    // Agent.cancel already aborts the maintenance controller; the facet now
    // says so, so the control can show the stop it accepted.
    agent.cancel({ kind: 'user' })
    expect(agent.activity).toBe('stopping')
    expect(agent.status).toBe('idle')

    release.resolve(undefined)
    await expect(maintenance).resolves.toBe(true)
    expect(agent.activity).toBeUndefined()
    expect(trace).toEqual(['activity:maintenance', 'activity:stopping', 'activity:undefined'])
  })

  it('publishes no activity transition across an ordinary uninterrupted turn', async () => {
    const ctx = await harness(new MockAdapter([textResponse('done')]))
    const agent = ctx.agentLoop.create(SessionId('quiet-facet'), { provider: 'mock', model: 'mock' })
    const trace = traceFacets(ctx, agent)

    send(agent, 'just answer')
    await waitForIdle(ctx, agent)

    expect(trace).toEqual(['status:running', 'status:idle'])
    expect(agent.activity).toBeUndefined()
  })

  it('is a no-op on an idle agent, which has nothing to stop', async () => {
    const ctx = await harness(new MockAdapter([textResponse('done')]))
    const agent = ctx.agentLoop.create(SessionId('idle-cancel-facet'), { provider: 'mock', model: 'mock' })
    const trace = traceFacets(ctx, agent)

    agent.cancel({ kind: 'user' })

    expect(agent.activity).toBeUndefined()
    expect(trace).toEqual([])
  })
})
