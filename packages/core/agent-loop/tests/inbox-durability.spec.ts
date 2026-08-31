import { createUserMessage } from '@deepseek-ai/dsh-llm'
/**
 * Regression tests for inbox durability: an abort landing after the durable
 * claim but before the step starts restores the unstarted batch to the inbox,
 * and lifecycle teardown keeps pending input so a remounted lifecycle can
 * resume it.
 * @module dsh-agent-loop/tests/inbox-durability
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

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

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function mountPersistentHarness(root: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function persistentHarness(adapter: MockAdapter): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-inbox-durability-'))
  dirs.push(root)
  return { ctx: await mountPersistentHarness(root, adapter), root }
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Resolve on the agent's next idle transition (event-based, not status poll). */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** All user-message texts recorded in the log (to assert what actually ran). */
function userTexts(agent: Agent): string[] {
  return agent.session.events
    .filter(e => e.type === 'user/message')
    .flatMap(e => e.type === 'user/message' ? e.data.content : [])
    .flatMap(b => b.type === 'text' ? [b.text] : [])
}

/** Block the next pre-step for this agent until its turn signal aborts. */
function blockNextPreStep(ctx: Context, agent: Agent): Promise<undefined> {
  const blocked = Promise.withResolvers<undefined>()
  let armed = true
  ctx.on('agent/pre-step', async ({ agent: subject, signal }, next) => {
    if (subject === agent && armed) {
      armed = false
      blocked.resolve(undefined)
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
    }
    return next()
  })
  return blocked.promise
}

describe('pre-step abort restores the claimed batch', () => {
  it('restores a claimed waking message when cancellation aborts its pre-step', async () => {
    const adapter = new MockAdapter([textResponse('A reply'), textResponse('B reply')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('restore-claimed-wake'), { provider: 'mock', model: 'mock' })
    const blocked = blockNextPreStep(ctx, agent)

    send(agent, 'A')
    await blocked
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    // The claim was durable but no model request ever saw the message: it
    // returns to the inbox instead of vanishing with the aborted turn.
    expect(agent.inbox.nextTurn.map(message => message.content[0])).toEqual([{ type: 'text', text: 'A' }])
    expect(userTexts(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(agent.session.events.some(event =>
      event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')).toBe(false)

    const idle = waitForIdle(ctx, agent)
    send(agent, 'B')
    await idle
    expect(userTexts(agent)).toEqual(['A', 'B'])
    expect(adapter.requests).toHaveLength(2)
  })

  it('does not duplicate a claimed message a listener already re-queued during the abort', async () => {
    const adapter = new MockAdapter([textResponse('A reply'), textResponse('B reply')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('restore-claimed-dedupe'), { provider: 'mock', model: 'mock' })
    const blocked = Promise.withResolvers<undefined>()
    let armed = true
    ctx.on('agent/pre-step', async ({ agent: subject, messages, signal }, next) => {
      if (subject === agent && armed) {
        armed = false
        blocked.resolve(undefined)
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        // The listener re-queues the claimed batch itself before unwinding.
        for (const message of messages) subject.inbox.append('next-turn', message)
      }
      return next()
    })

    send(agent, 'A')
    await blocked.promise
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    expect(agent.inbox.nextTurn.map(message => message.content[0])).toEqual([{ type: 'text', text: 'A' }])

    const idle = waitForIdle(ctx, agent)
    send(agent, 'B')
    await idle
    expect(userTexts(agent)).toEqual(['A', 'B'])
    expect(adapter.requests).toHaveLength(2)
  })

  it('restores claimed steering when cancellation aborts a continuation pre-step', async () => {
    const adapter = new MockAdapter([textResponse('first reply'), textResponse('after steering')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('restore-claimed-steering'), { provider: 'mock', model: 'mock' })
    let preSteps = 0
    const blocked = Promise.withResolvers<undefined>()
    ctx.on('agent/pre-step', async ({ agent: subject, signal }, next) => {
      if (subject !== agent) return next()
      preSteps += 1
      if (preSteps === 1) {
        // Steering staged during the first pre-step is claimed by the second.
        subject.steer(createUserMessage({
          content: [{ type: 'text', text: 'staged steering' }],
          source: { kind: 'user' },
        }))
      } else if (preSteps === 2) {
        blocked.resolve(undefined)
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
      }
      return next()
    })

    send(agent, 'go')
    await blocked.promise
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    expect(agent.inbox.nextStep.map(message => message.content[0]))
      .toEqual([{ type: 'text', text: 'staged steering' }])
    expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'continue')
    await idle
    const request = JSON.stringify(adapter.requests[1]?.messages)
    expect(request).toContain('staged steering')
    expect(request).toContain('continue')
  })

  it('rejects overlapping maintenance while the agent is active', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = ctx.agentLoop.create(SessionId('maintenance-overlap'), { provider: 'mock', model: 'mock' })
    const release = Promise.withResolvers<undefined>()
    const running = agent.runMaintenance(async () => release.promise)
    expect(() => agent.runMaintenance(async () => undefined)).toThrow(/already has active work/)
    release.resolve(undefined)
    await running
  })

  it('keeps a pending inbox across disposal so a remount can resume it', async () => {
    const sessionId = SessionId('inbox-survives-teardown')
    const first = await persistentHarness(new MockAdapter([]))
    const handle = await first.ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.send(createUserMessage({
      content: [{ type: 'text', text: 'queued survivor' }],
      source: { kind: 'user' },
    }), 'next-turn', false)
    await handle.dispose()
    await first.ctx.fiber.dispose()

    const secondCtx = await mountPersistentHarness(first.root, new MockAdapter([]))
    const resumed = await secondCtx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    expect(resumed.agent.inbox.nextTurn.map(message => message.content[0]))
      .toEqual([{ type: 'text', text: 'queued survivor' }])
    expect(resumed.agent.session.events.some(event =>
      event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')).toBe(false)
    await secondCtx.fiber.dispose()
  })
})
