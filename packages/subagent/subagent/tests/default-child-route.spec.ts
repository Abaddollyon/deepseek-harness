import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'

const SOL = { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: ReasoningEffortId('xhigh') }

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  return ctx
}

describe('default child route', () => {
  it('resolves the nearest declaration on the scope chain over the global one, as a detached copy', async () => {
    const ctx = await setup()
    const preset = {}
    const agent = {}
    bindScopeParent(agent, preset)
    let presetCtx!: Context
    await ctx.plugin(Object.assign((inner: Context) => { presetCtx = createScope(inner, preset).ctx }, { inject: ['subagents'] }))
    expect(ctx.subagents.defaultChildRoute(agent)).toBeUndefined()

    const disposeGlobal = ctx.subagents.declareDefaultChildRoute({ provider: 'deepseek', model: 'v4' })
    expect(ctx.subagents.defaultChildRoute(agent)).toEqual({ provider: 'deepseek', model: 'v4' })
    const disposePreset = presetCtx.subagents.declareDefaultChildRoute(SOL)
    const seen = ctx.subagents.defaultChildRoute(agent)
    expect(seen).toEqual(SOL)
    expect(ctx.subagents.defaultChildRoute()).toEqual({ provider: 'deepseek', model: 'v4' })
    expect(ctx.subagents.defaultChildRoute(agent)).not.toBe(seen)
    expect(() => presetCtx.subagents.declareDefaultChildRoute(SOL)).toThrow(/already declared for this scope/)

    disposePreset()
    expect(ctx.subagents.defaultChildRoute(agent)).toEqual({ provider: 'deepseek', model: 'v4' })
    disposeGlobal()
    expect(ctx.subagents.defaultChildRoute(agent)).toBeUndefined()
  })
})
