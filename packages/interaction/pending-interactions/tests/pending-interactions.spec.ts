import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import PendingInteractionRegistry from '../src/index.ts'

function agent(id: string): Agent {
  return { id, session: { id } } as unknown as Agent
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PendingInteractionRegistry', () => {
  it('gives late observers a content-free snapshot and revisioned begin/end changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T07:00:00.000Z'))
    const ctx = new Context()
    await ctx.plugin(PendingInteractionRegistry)
    const subject = agent('session-a')

    const end = ctx.pendingInteractions.begin({ kind: 'approval', agent: subject })
    const first = ctx.pendingInteractions.snapshot()
    expect(typeof first.epoch).toBe('string')
    expect(typeof first.pending[0]?.id).toBe('string')
    expect(first).toEqual({
      epoch: first.epoch,
      revision: 1,
      pending: [{
        id: first.pending[0]?.id,
        kind: 'approval',
        agentId: 'session-a',
        sessionId: 'session-a',
        startedAtMs: 1_788_591_600_000,
      }],
    })
    expect(Object.keys(first.pending[0]!)).toEqual([
      'id', 'kind', 'agentId', 'sessionId', 'startedAtMs',
    ])

    const changes: unknown[] = []
    ctx.pendingInteractions.onChange((change) => { changes.push(change) })
    vi.setSystemTime(new Date('2026-09-05T07:00:01.000Z'))
    end()
    end()
    await Promise.resolve()

    expect(changes).toEqual([{
      epoch: first.epoch,
      revision: 2,
      type: 'ended',
      interaction: first.pending[0],
      endedAtMs: 1_788_591_601_000,
    }])
    expect(ctx.pendingInteractions.snapshot()).toEqual({
      epoch: first.epoch,
      revision: 2,
      pending: [],
    })
  })

  it('contains synchronous and asynchronous observer failures without skipping observers', async () => {
    const ctx = new Context()
    await ctx.plugin(PendingInteractionRegistry)
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    const seen: string[] = []
    ctx.pendingInteractions.onChange(() => { throw new Error('sync observer') })
    ctx.pendingInteractions.onChange(() => Promise.reject(new Error('async observer')))
    ctx.pendingInteractions.onChange((change) => { seen.push(change.type) })

    const end = ctx.pendingInteractions.begin({ kind: 'question' })
    end()
    await Promise.resolve()
    await Promise.resolve()

    expect(seen).toEqual(['began', 'ended'])
    expect(error).toHaveBeenCalledTimes(4)
  })

  it('clears an agent request on disposal and all requests on Host shutdown', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const registryFiber = await ctx.plugin(PendingInteractionRegistry)
    const first = agent('first')
    const second = agent('second')
    const disposeFirst = ctx.agents.register(first)
    ctx.agents.register(second)
    ctx.pendingInteractions.begin({ kind: 'approval', agent: first })
    ctx.pendingInteractions.begin({ kind: 'plan-review', agent: second })
    ctx.pendingInteractions.begin({ kind: 'question' })

    disposeFirst()
    expect(ctx.pendingInteractions.snapshot().pending.map(entry => entry.kind)).toEqual([
      'plan-review', 'question',
    ])

    const registry = ctx.pendingInteractions
    await registryFiber.dispose()
    expect(registry.snapshot().pending).toEqual([])
    expect(ctx.get('pendingInteractions')).toBeUndefined()
  })

  it('unsubscribes before queued delivery and does not replay history', async () => {
    const ctx = new Context()
    await ctx.plugin(PendingInteractionRegistry)
    const seen: string[] = []
    const unsubscribe = ctx.pendingInteractions.onChange(change => seen.push(change.type))
    ctx.pendingInteractions.begin({ kind: 'question' })
    unsubscribe()
    await Promise.resolve()
    expect(seen).toEqual([])
  })
})
