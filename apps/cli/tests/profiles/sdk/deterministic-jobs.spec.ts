import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JobStart } from '@deepseek-ai/dsh-jobs'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import DeterministicJobs from './fixtures/deterministic-jobs.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DeterministicJobs)
  const tools = await ctx.plugin(ToolJobs)
  return { ctx, tools }
}

function producer(idHint?: string): JobStart {
  return {
    kind: 'subagent',
    label: 'diagnostic child',
    ...idHint === undefined ? {} : { idHint },
    run: () => ({
      cancel() {},
      done: Promise.resolve({ status: 'completed', output: 'child output' }),
    }),
  }
}

describe('SDK diagnostic job identities', () => {
  it('retains explicit hints and scopes fallback counters to each registry', async () => {
    const { ctx } = await harness()
    expect(ctx.jobs.start(producer('explicit'))).toBe('subagent-explicit')
    expect(ctx.jobs.start(producer())).toBe('subagent-1')
    expect(ctx.jobs.start(producer())).toBe('subagent-2')
    const other = await harness()
    expect(other.ctx.jobs.start(producer())).toBe('subagent-1')
  })

  it('routes the deterministic id through real job_output execution', async () => {
    const { ctx } = await harness()
    expect(ctx.jobs.start(producer())).toBe('subagent-1')
    const result = await ctx.tools.execute({
      callId: ToolCallId('diagnostic-output'),
      name: 'job_output',
      arguments: { job_id: 'subagent-1', wait: true },
      signal: new AbortController().signal,
    })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'child output\n[status: completed]' }])
  })

  it('keeps real collision and controller admission checks before producer execution', async () => {
    const { ctx, tools } = await harness()
    ctx.jobs.start(producer('same'))
    const run = vi.fn(() => producer().run())
    expect(() => ctx.jobs.start({ ...producer('same'), run })).toThrow('job id subagent-same is already registered (idHint collision)')
    expect(run).not.toHaveBeenCalled()
    await tools.dispose()
    expect(() => ctx.jobs.start({ ...producer(), run })).toThrow('no job controller serves this agent')
    expect(run).not.toHaveBeenCalled()
  })
})
