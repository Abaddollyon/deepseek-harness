import { describe, expect, it } from 'vitest'
import { RouteRequestLimiter } from '../src/request-limit.ts'

/** Track which acquisitions have been admitted, in admission order. */
function tracker(limiter: RouteRequestLimiter) {
  const admitted: string[] = []
  const slots = new Map<string, Disposable>()
  const start = (name: string, route: string, limit: number | undefined, signal?: AbortSignal): Promise<void> =>
    limiter.acquire(route, limit, signal).then((slot) => {
      admitted.push(name)
      slots.set(name, slot)
    })
  const release = (name: string): void => { slots.get(name)?.[Symbol.dispose]() }
  return { admitted, start, release }
}

/** Let queued admissions settle; every limiter transition resolves within microtasks. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

describe('RouteRequestLimiter', () => {
  it('admits up to the limit and queues the rest in arrival order', async () => {
    const { admitted, start, release } = tracker(new RouteRequestLimiter())
    for (const name of ['a', 'b', 'c', 'd']) void start(name, 'route', 2)
    await settle()
    expect(admitted).toEqual(['a', 'b'])

    release('b')
    await settle()
    expect(admitted).toEqual(['a', 'b', 'c'])
    release('a')
    await settle()
    expect(admitted).toEqual(['a', 'b', 'c', 'd'])
  })

  it('admits every request at once when the route has no limit', async () => {
    const { admitted, start } = tracker(new RouteRequestLimiter())
    await Promise.all(Array.from({ length: 50 }, async (_, index) => { await start(`r${index}`, 'route', undefined) }))
    expect(admitted).toHaveLength(50)
  })

  it('keeps routes independent', async () => {
    const { admitted, start } = tracker(new RouteRequestLimiter())
    void start('a1', 'a', 1)
    void start('a2', 'a', 1)
    void start('b1', 'b', 1)
    await settle()
    expect(admitted).toEqual(['a1', 'b1'])
  })

  it('rejects a request aborted while queued with its abort reason and admits the next one', async () => {
    const limiter = new RouteRequestLimiter()
    const { admitted, start, release } = tracker(limiter)
    const controller = new AbortController()
    void start('first', 'route', 1)
    await settle()
    const aborted = limiter.acquire('route', 1, controller.signal)
    void start('next', 'route', 1)
    await settle()
    const reason = new Error('turn cancelled')
    controller.abort(reason)

    await expect(aborted).rejects.toBe(reason)
    expect(admitted).toEqual(['first'])
    release('first')
    await settle()
    expect(admitted).toEqual(['first', 'next'])
  })

  it('admits an already aborted request only while the route has capacity', async () => {
    const limiter = new RouteRequestLimiter()
    const { admitted, start, release } = tracker(limiter)
    const reason = new Error('already cancelled')
    const signal = AbortSignal.abort(reason)
    await start('aborted-with-capacity', 'route', 1, signal)
    await expect(limiter.acquire('route', 1, signal)).rejects.toBe(reason)
    void start('waiting', 'route', 1)
    await settle()
    expect(admitted).toEqual(['aborted-with-capacity'])
    release('aborted-with-capacity')
    await settle()
    expect(admitted).toEqual(['aborted-with-capacity', 'waiting'])
  })

  it('forgets a route once its last admitted or queued request leaves', async () => {
    const limiter = new RouteRequestLimiter()
    const { start, release } = tracker(limiter)
    const controller = new AbortController()
    void start('limited', 'limited', 1)
    void start('unlimited', 'unlimited', undefined)
    await settle()
    const leaving = limiter.acquire('limited', 1, controller.signal)
    await settle()
    expect(limiter.activeRoutes).toBe(2)

    controller.abort(new Error('turn cancelled'))
    await expect(leaving).rejects.toThrow('turn cancelled')
    release('unlimited')
    expect(limiter.activeRoutes).toBe(1)
    release('limited')
    expect(limiter.activeRoutes).toBe(0)
  })

  it('admits queued requests when a later request raises or removes the limit', async () => {
    const { admitted, start, release } = tracker(new RouteRequestLimiter())
    const signal = new AbortController().signal
    void start('a', 'route', 1)
    void start('b', 'route', 1, signal)
    void start('c', 'route', 1)
    await settle()
    expect(admitted).toEqual(['a'])

    void start('d', 'route', 2)
    await settle()
    expect(admitted).toEqual(['a', 'b'])
    void start('e', 'route', undefined)
    await settle()
    // Unlimited capacity admits every waiter and the newcomer in the same turn.
    expect(admitted).toHaveLength(5)
    expect(admitted).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd', 'e']))
    release('a')
  })

  it('lets admitted requests finish when a later request lowers the limit', async () => {
    const { admitted, start, release } = tracker(new RouteRequestLimiter())
    void start('a', 'route', 2)
    void start('b', 'route', 2)
    void start('c', 'route', 1)
    await settle()
    expect(admitted).toEqual(['a', 'b'])

    release('a')
    await settle()
    expect(admitted).toEqual(['a', 'b'])
    release('b')
    await settle()
    expect(admitted).toEqual(['a', 'b', 'c'])
  })

  it('releases each slot once however often it is disposed', async () => {
    const { admitted, start, release } = tracker(new RouteRequestLimiter())
    void start('a', 'route', 1)
    void start('b', 'route', 1)
    void start('c', 'route', 1)
    await settle()
    release('a')
    release('a')
    await settle()
    expect(admitted).toEqual(['a', 'b'])
  })
})
