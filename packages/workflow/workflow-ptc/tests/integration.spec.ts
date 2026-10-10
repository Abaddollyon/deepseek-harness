import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { recordSubagentModelSelection, subagentModelSelectionProjectionDefinition } from '@deepseek-ai/dsh-tool-subagent/src/model-selection-state.ts'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import PtcWorkflowEngine from '../src/index.ts'
import type { Config as PtcWorkflowConfig } from '../src/index.ts'
import { mountPtcRuntime } from './setup.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const REASONING = {
  efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
  defaultEffort: ReasoningEffortId('high'),
}

async function setup(
  script: Script,
  reasoning?: typeof REASONING,
  parentOptions: AgentOptions = { provider: 'mock', model: 'mock' },
  engineConfig: PtcWorkflowConfig = {},
) {
  const ctx = new Context()
  const adapter = new MockAdapter(script, reasoning)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const { cwd } = await mountPtcRuntime(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(PtcWorkflowEngine, engineConfig)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), parentOptions, { cwd })
  return { ctx, parent, adapter }
}

describe('dsh-workflow-ptc over the real in-process stack', () => {
  it('runs a two-stage workflow: a plain child, then a schema child through the structured runtime', async () => {
    const { ctx, parent } = await setup([
      textResponse('the file list is a.ts'),
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { verdict: 'real', confidence: 0.9 }),
    ])
    const childIds: string[] = []
    const parentFollowup = vi.spyOn(parent, 'followup')
    const parentSteer = vi.spyOn(parent, 'steer')
    const published = new Set<string>()
    ctx.on('subagent/start', (child) => { published.add(child.id) })
    ctx.on('workflow/agent-start', (_info, agent) => {
      expect(published.has(agent.childId)).toBe(true)
      childIds.push(agent.childId)
    })
    const run = ctx.workflowEngine.start({
      meta: { name: 'integration', description: 'plain + structured children' },
      script: `phase('Read')
const prose = await agent('read the repo')
phase('Judge')
const judged = await agent('judge: ' + prose, {
  schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['real', 'bogus'] }, confidence: { type: 'number' } }, required: ['verdict'] },
})
return { prose, verdict: judged.verdict, confidence: judged.confidence }`,
      parent,
    })
    const result = await run.result
    expect(result.stopReason, result.error?.split('\n')[0]).toBe('completed')
    expect(result.value).toEqual({ prose: 'the file list is a.ts', verdict: 'real', confidence: 0.9 })
    expect(result.agentsStarted).toBe(2)
    await run.dispose()
    expect(parentFollowup).not.toHaveBeenCalled()
    expect(parentSteer).not.toHaveBeenCalled()
    expect(parent.session.snapshotEvents()
      .filter(event => event.type === 'subagent/catalog')
      .map(event => ({ id: event.data.childId, mode: event.data.mode })))
      .toEqual(childIds.map(id => ({ id, mode: 'continuable' })))
    // Both children were disposed to quiescence — no live child agents remain.
    expect(childIds.length).toBe(2)
    for (const childId of childIds) {
      expect(ctx.agents.get(SessionId(childId))).toBeUndefined()
    }
  })

  it('a child that fails against its schema (nudges exhausted) reaches the script as null', async () => {
    const { ctx, parent } = await setup([
      textResponse('prose only'),
      textResponse('still prose after the nudge'),
    ])
    const run = ctx.workflowEngine.start({
      meta: { name: 'null-path', description: 'schema failure maps to null' },
      script: `const judged = await agent('judge it', { schema: { type: 'object', properties: { v: { type: 'string' } } } })
return { got: judged === null ? 'null' : 'value' }`,
      parent,
    })
    const result = await run.result
    expect(result.stopReason, result.error?.split('\n')[0]).toBe('completed')
    expect(result.value).toEqual({ got: 'null' })
    await run.dispose()
  })

  it('applies agent({reasoningEffort}) to the child request; an omitted effort keeps the inherited route', async () => {
    const { ctx, parent, adapter } = await setup(
      [textResponse('high child'), textResponse('inherited child')],
      REASONING,
      { provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('low') },
    )
    const run = ctx.workflowEngine.start({
      meta: { name: 'effort', description: 'per-child reasoning effort' },
      script: `const high = await agent('think hard', { reasoningEffort: 'high' })
const inherited = await agent('think as the parent does')
return [high, inherited]`,
      parent,
    })
    try {
      const result = await run.result
      expect(result.stopReason, result.error?.split('\n')[0]).toBe('completed')
      expect(result.value).toEqual(['high child', 'inherited child'])
      expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'low'])
    } finally {
      await run.dispose()
    }
  })

  it('rejects a reasoning effort the effective child model does not offer before starting the child', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('never sent')], REASONING)
    const start = vi.spyOn(ctx.subagents, 'startActivation')
    const run = ctx.workflowEngine.start({
      meta: { name: 'bad-effort', description: 'unsupported reasoning effort' },
      script: "return await agent('think', { model: 'other', reasoningEffort: 'max' })",
      parent,
    })
    try {
      const result = await run.result
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('provider "mock" model "other" does not support reasoning effort "max"')
      expect(start).not.toHaveBeenCalled()
      expect(adapter.requests).toHaveLength(0)
    } finally {
      await run.dispose()
    }
  })

  describe('configured child route defaults', () => {
    const XHIGH = {
      efforts: [...REASONING.efforts, { id: ReasoningEffortId('xhigh'), name: 'Extra high' }],
      defaultEffort: ReasoningEffortId('high'),
    }

    it('starts every child on the configured route; a call effort overrides it and a changed route drops it', async () => {
      const { ctx, parent, adapter } = await setup(
        ['default child', 'low child', 'other model child', 'other provider child', 'named route child'].map(text => textResponse(text)),
        XHIGH,
        { provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('low') },
        { agentOptions: { provider: 'mock', model: 'mock', reasoningEffort: 'xhigh' } },
      )
      ctx.llm.registerAdapter(['alt'], adapter)
      const start = vi.spyOn(ctx.subagents, 'startActivation')
      const run = ctx.workflowEngine.start({
        meta: { name: 'defaults', description: 'configured child route' },
        script: `const first = await agent('use the defaults')
const second = await agent('think less', { reasoningEffort: 'low' })
const third = await agent('other model', { model: 'other' })
const fourth = await agent('other provider', { provider: 'alt', model: 'mock' })
const fifth = await agent('the configured route by name', { provider: 'mock', model: 'mock' })
return [first, second, third, fourth, fifth]`,
        parent,
      })
      try {
        const result = await run.result
        expect(result.stopReason, result.error?.split('\n')[0]).toBe('completed')
        expect(start.mock.calls.map(([spec]) => spec.request.agentOptions)).toEqual([
          { provider: 'mock', model: 'mock', reasoningEffort: 'xhigh' },
          { provider: 'mock', model: 'mock', reasoningEffort: 'low' },
          { provider: 'mock', model: 'other' },
          { provider: 'alt', model: 'mock' },
          { provider: 'mock', model: 'mock', reasoningEffort: 'xhigh' },
        ])
        expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['xhigh', 'low', 'high', 'high', 'xhigh'])
      } finally {
        await run.dispose()
      }
    })

    it('starts a child on a provider that cannot apply a route without the configured defaults', async () => {
      const { ctx, parent } = await setup([], XHIGH, undefined, { agentOptions: { provider: 'mock', model: 'mock', reasoningEffort: 'xhigh' } })
      const seen: SubagentStartRequest[] = []
      ctx.subagents.registerProvider({
        name: 'fixed',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: (request) => {
          seen.push(request)
          return Promise.resolve({
            id: SessionId('fixed-child'),
            result: Promise.resolve({ output: [{ type: 'text' as const, text: 'fixed child' }], stopReason: 'completed' as const }),
            dispose: () => Promise.resolve(),
          })
        },
      })
      const run = ctx.workflowEngine.start({
        meta: { name: 'fixed-route', description: 'provider without agentOptions' },
        script: "return await agent('go', { subagentProvider: 'fixed' })",
        parent,
      })
      try {
        await expect(run.result).resolves.toMatchObject({ stopReason: 'completed', value: 'fixed child' })
        expect(seen).toHaveLength(1)
        expect(seen[0]).not.toHaveProperty('agentOptions')
      } finally {
        await run.dispose()
      }
    })

    it('limits an explicit route to the Session\'s allowed routes when a selection policy is recorded', async () => {
      const { ctx, parent } = await setup([textResponse('allowed child')], XHIGH)
      ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
      recordSubagentModelSelection(ctx.sessionProjections, parent.session, [{ provider: 'mock', model: 'mock' }])
      const start = vi.spyOn(ctx.subagents, 'startActivation')
      const refused = ctx.workflowEngine.start({
        meta: { name: 'refused-route', description: 'route outside the pool' },
        script: "return await agent('go', { model: 'other' })",
        parent,
      })
      const allowed = ctx.workflowEngine.start({
        meta: { name: 'allowed-route', description: 'route inside the pool' },
        script: "return await agent('go', { provider: 'mock', model: 'mock', reasoningEffort: 'xhigh' })",
        parent,
      })
      try {
        const result = await refused.result
        expect(result.stopReason).toBe('error')
        expect(result.error).toContain('child LLM route "mock/other" is not allowed for this Session')
        await expect(allowed.result).resolves.toMatchObject({ stopReason: 'completed', value: 'allowed child' })
        expect(start).toHaveBeenCalledTimes(1)
      } finally {
        await refused.dispose()
        await allowed.dispose()
      }
    })

    it('fails the workflow before the child starts when the route does not offer the configured effort', async () => {
      const { ctx, parent, adapter } = await setup(
        [textResponse('never sent')],
        REASONING,
        undefined,
        { agentOptions: { provider: 'mock', model: 'mock', reasoningEffort: 'xhigh' } },
      )
      const start = vi.spyOn(ctx.subagents, 'startActivation')
      const run = ctx.workflowEngine.start({
        meta: { name: 'bad-default', description: 'unsupported configured effort' },
        script: "return await agent('think')",
        parent,
      })
      try {
        const result = await run.result
        expect(result.stopReason).toBe('error')
        expect(result.error).toContain('provider "mock" model "mock" does not support reasoning effort "xhigh"')
        expect(start).not.toHaveBeenCalled()
        expect(adapter.requests).toHaveLength(0)
      } finally {
        await run.dispose()
      }
    })

    it('keeps a configured effort without a route when a call names the parent\'s own route', async () => {
      const { ctx, parent, adapter } = await setup(
        [textResponse('same route'), textResponse('other model')],
        XHIGH,
        { provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('low') },
        { agentOptions: { reasoningEffort: 'xhigh' } },
      )
      const start = vi.spyOn(ctx.subagents, 'startActivation')
      const run = ctx.workflowEngine.start({
        meta: { name: 'parent-route', description: 'parent route named' },
        script: "return [await agent('same', { provider: 'mock', model: 'mock' }), await agent('other', { model: 'other' })]",
        parent,
      })
      try {
        await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
        expect(start.mock.calls.map(([spec]) => spec.request.agentOptions)).toEqual([
          { provider: 'mock', model: 'mock', reasoningEffort: 'xhigh' },
          { model: 'other' },
        ])
        expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['xhigh', 'high'])
      } finally {
        await run.dispose()
      }
    })

    it('passes a configured effort and token limit without a route, a route without an effort, and rejects a route missing its model', async () => {
      const { ctx, parent } = await setup(
        [textResponse('child')],
        REASONING,
        undefined,
        { agentOptions: { reasoningEffort: 'low', maxTokens: 512 } },
      )
      const start = vi.spyOn(ctx.subagents, 'startActivation')
      const run = ctx.workflowEngine.start({ meta: { name: 'effort-only', description: 'effort only' }, script: "return await agent('go')", parent })
      try {
        await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
        expect(start.mock.calls[0]?.[0].request.agentOptions).toEqual({ reasoningEffort: 'low', maxTokens: 512 })
      } finally {
        await run.dispose()
      }
      const routed = await setup([textResponse('child')], REASONING, undefined, { agentOptions: { provider: 'mock', model: 'mock' } })
      const routedStart = vi.spyOn(routed.ctx.subagents, 'startActivation')
      const routedRun = routed.ctx.workflowEngine.start({ meta: { name: 'route-only', description: 'route only' }, script: "return await agent('go')", parent: routed.parent })
      try {
        await expect(routedRun.result).resolves.toMatchObject({ stopReason: 'completed' })
        expect(routedStart.mock.calls[0]?.[0].request.agentOptions).toEqual({ provider: 'mock', model: 'mock' })
      } finally {
        await routedRun.dispose()
      }
      await expect(setup([], undefined, undefined, { agentOptions: { provider: 'mock' } }))
        .rejects.toThrow('configure `agentOptions.provider` and `agentOptions.model` together')
    })
  })

  it('pairs published children with workflow progress after a progress burst', async () => {
    const { ctx, parent } = await setup([textResponse('child complete')])
    const logs: string[] = []
    const published = new Set<string>()
    const starts: string[] = []
    ctx.on('subagent/start', (child) => { published.add(child.id) })
    ctx.on('workflow/log', (_info, message) => { logs.push(message) })
    ctx.on('workflow/agent-start', (_info, child) => {
      expect(published.has(child.childId)).toBe(true)
      starts.push(child.childId)
    })
    const run = ctx.workflowEngine.start({
      meta: { name: 'progress-burst', description: 'ordered progress and child visibility' },
      script: 'for (let index = 0; index < 200; index++) log(String(index)); return await agent("finish")',
      parent,
    })
    try {
      await expect(run.result).resolves.toMatchObject({ value: 'child complete', stopReason: 'completed', agentsStarted: 1 })
      expect(logs).toEqual(Array.from({ length: 200 }, (_, index) => String(index)))
      expect(starts).toHaveLength(1)
      expect(ctx.agents.get(SessionId(starts[0]!))).toBeUndefined()
    } finally {
      await run.dispose()
    }
  })
})
