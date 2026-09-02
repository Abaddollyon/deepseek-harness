import { createUserMessage } from '@deepseek-ai/dsh-llm'
/**
 * Regression tests for teardown settlement durability: disposal awaits a
 * session flush after the driver reaches quiescence and before the scope
 * unwinds, so a final tool result committed at the teardown edge cannot be
 * lost inside the write-behind window.
 * @module dsh-agent-loop/tests/teardown-flush
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function mountPersistentHarness(root: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function persistentHarness(adapter: MockAdapter): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-teardown-flush-'))
  dirs.push(root)
  return { ctx: await mountPersistentHarness(root, adapter), root }
}

/** Resolve on the agent's next idle transition (event-based, not status poll). */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Run one tool turn to quiescence so its result is the final appended record. */
async function settleToolTurn(ctx: Context, agent: Agent): Promise<void> {
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'settle one durable result',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: 'probe result' }]
    },
  }))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  if (!agent.session.snapshotEvents().some(event => event.type === 'tool/result')) {
    throw new Error('expected the tool turn to settle a durable tool/result')
  }
}

describe('disposal flushes the settled log', () => {
  it('awaits a flush that observes the final tool result, then survives a remount', async () => {
    const sessionId = SessionId('teardown-flush-barrier')
    const first = await persistentHarness(new MockAdapter([toolCallResponse('c1', 'probe', {}), textResponse('done')]))
    const handle = await first.ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await settleToolTurn(first.ctx, handle.agent)

    // Gate the durability barrier: disposal must dispatch a flush that already
    // observes the settled tool/result, and must not settle before it.
    let sawToolResult = false
    let release: (() => void) | undefined
    const flushed = Promise.withResolvers<undefined>()
    first.ctx.on('session/flush', async (session) => {
      if (session !== handle.agent.session || release !== undefined) return
      sawToolResult = session.snapshotEvents().some(event => event.type === 'tool/result')
      flushed.resolve(undefined)
      await new Promise<void>((resolve) => { release = resolve })
    })

    let disposeSettled = false
    const disposal = handle.dispose().then(() => { disposeSettled = true })
    await flushed.promise
    await Promise.resolve()
    expect(disposeSettled).toBe(false)
    release?.()
    await disposal

    expect(sawToolResult).toBe(true)
    await first.ctx.fiber.dispose()

    // The barrier made the closing records durable: a remount reads them back.
    const secondCtx = await mountPersistentHarness(first.root, new MockAdapter([]))
    const loaded = await secondCtx.sessionPersistence.load(sessionId)
    expect(loaded.events.some(event => event.type === 'tool/result')).toBe(true)
    expect(loaded.events.some(event => event.type === 'turn/end')).toBe(true)
    await secondCtx.fiber.dispose()
  })

  it('warns instead of failing teardown when the flush fails', async () => {
    const sessionId = SessionId('teardown-flush-failure')
    const first = await persistentHarness(new MockAdapter([toolCallResponse('c1', 'probe', {}), textResponse('done')]))
    const handle = await first.ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await settleToolTurn(first.ctx, handle.agent)
    first.ctx.on('session/flush', (session) => {
      if (session === handle.agent.session) return Promise.reject(new Error('disk full'))
    })
    const warn = vi.spyOn(first.ctx.logger, 'warn')

    await handle.dispose()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('teardown session flush failed'))
    expect(first.ctx.agents.get(sessionId)).toBeUndefined()
    await first.ctx.fiber.dispose()
  })
})
