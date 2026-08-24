import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { RequestContext, Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ModelRouteProjection } from '@deepseek-ai/dsh-token-meter/client'

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

/** Read the registered unit's current whole value, failing loudly when the key is absent. */
const routeOf = (ctx: Context, session: Session): ModelRouteProjection | null => {
  const values = ctx.sessionProjections.snapshot(session).values
  if (!('modelRoute' in values)) throw new Error('modelRoute projection is not registered')
  return values.modelRoute ?? null
}

/** Fold the same log from scratch the way a cold read does: seq order, empty checkpoint. */
const coldRoute = (ctx: Context, session: Session): ModelRouteProjection | null => {
  const restored = ctx.sessionProjections.restore({}, session.events, 0, session.header).snapshot.values
  if (!('modelRoute' in restored)) throw new Error('modelRoute projection is not registered')
  return restored.modelRoute ?? null
}

const route = (session: Session, value: RequestContext): void => {
  session.append('request/context', value)
}

describe('modelRoute projection', () => {
  it('is null before the session issues any request', async () => {
    const { ctx, session } = await harness()
    expect(routeOf(ctx, session)).toBeNull()
  })

  it('stays null for a session that logs turns and steps but never issues a request', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(routeOf(ctx, session)).toBeNull()
  })

  it('reports the route of the first request/context record', async () => {
    const { ctx, session } = await harness()
    route(session, { provider: 'provider-a', model: 'model-one', contextWindow: 4096 })
    expect(routeOf(ctx, session)).toEqual({ provider: 'provider-a', model: 'model-one', contextWindow: 4096 })
  })

  it('omits contextWindow for a route that advertises none', async () => {
    const { ctx, session } = await harness()
    route(session, { provider: 'provider-a', model: 'model-one' })
    expect(routeOf(ctx, session)).toEqual({ provider: 'provider-a', model: 'model-one' })
  })

  it('takes the last record when the route changes mid-session', async () => {
    const { ctx, session } = await harness()
    route(session, { provider: 'provider-a', model: 'model-one', contextWindow: 4096 })
    route(session, { provider: 'provider-b', model: 'model-two', contextWindow: 200_000 })
    expect(routeOf(ctx, session)).toEqual({ provider: 'provider-b', model: 'model-two', contextWindow: 200_000 })
  })

  it('drops a capacity the newer route does not advertise', async () => {
    const { ctx, session } = await harness()
    route(session, { provider: 'provider-a', model: 'model-one', contextWindow: 4096 })
    route(session, { provider: 'provider-a', model: 'model-two' })
    expect(routeOf(ctx, session)).toEqual({ provider: 'provider-a', model: 'model-two' })
  })

  it('emits one change per distinct route and none for a repeated record', async () => {
    const { ctx, session } = await harness()
    const seen: unknown[] = []
    ctx.sessionProjections.onChanged((changed, key, value) => {
      if (changed === session && key === 'modelRoute') seen.push(value)
    })
    route(session, { provider: 'provider-a', model: 'model-one' })
    route(session, { provider: 'provider-a', model: 'model-one' })
    route(session, { provider: 'provider-b', model: 'model-one' })
    expect(seen).toEqual([
      { provider: 'provider-a', model: 'model-one' },
      { provider: 'provider-b', model: 'model-one' },
    ])
  })

  it('reproduces the live value from a cold replay by seq', async () => {
    const { ctx, session } = await harness()
    route(session, { provider: 'provider-a', model: 'model-one', contextWindow: 4096 })
    session.append('turn/start', { turn: 1 })
    route(session, { provider: 'provider-b', model: 'model-two' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(coldRoute(ctx, session)).toEqual(routeOf(ctx, session))
    expect(coldRoute(ctx, session)).toEqual({ provider: 'provider-b', model: 'model-two' })
  })

  it('replays a never-requested session to the same null', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    expect(coldRoute(ctx, session)).toBeNull()
  })

  it('removes the key when the meter unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meterFiber = await ctx.plugin(TokenMeter)
    const session = ctx.sessions.create()
    route(session, { provider: 'provider-a', model: 'model-one' })
    expect(ctx.sessionProjections.snapshot(session).values).toHaveProperty('modelRoute')
    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('modelRoute')
  })
})
