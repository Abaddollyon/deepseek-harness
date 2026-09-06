import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ConnectionFactory, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function runtimeContext(): Promise<Context> {
  const ctx = new Context()
  ctx.provide('connection', {
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
  } as ConnectionHandle)
  ctx.provide('connectionFactory', { create: vi.fn() } as ConnectionFactory)
  await ctx.plugin({ apply, inject })
  return ctx
}

describe('local environment runtime plugin', () => {
  test('starts with empty presentation state when persisted storage cannot be read', async () => {
    const ctx = new Context()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => { throw new DOMException('denied', 'SecurityError') }),
      setItem: vi.fn(),
    })
    ctx.provide('connection', {
      generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    } as ConnectionHandle)
    ctx.provide('connectionFactory', { create: vi.fn() } as ConnectionFactory)

    await expect(ctx.plugin({ apply, inject })).resolves.toBeDefined()
    expect(ctx.environmentNavigation.presentation.get({ environmentId: 'local', sessionId: 'one' }))
      .toMatchObject({ draft: '', viewId: 'chat' })
    await ctx.fiber.dispose()
  })

  test('keeps presentation updates usable when persisted storage cannot be written', async () => {
    const ctx = new Context()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new DOMException('full', 'QuotaExceededError') }),
    })
    ctx.provide('connection', {
      generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    } as ConnectionHandle)
    ctx.provide('connectionFactory', { create: vi.fn() } as ConnectionFactory)
    await ctx.plugin({ apply, inject })

    expect(() => {
      ctx.environmentNavigation.presentation.update(
        { environmentId: 'local', sessionId: 'one' },
        { draft: 'still editable', viewId: 'work' },
      )
    }).not.toThrow()
    expect(ctx.environmentNavigation.presentation.get({ environmentId: 'local', sessionId: 'one' }))
      .toMatchObject({ draft: 'still editable', viewId: 'work' })
    await ctx.fiber.dispose()
  })

  test('writes the latest presentation once after 250 ms of quiet', async () => {
    vi.useFakeTimers()
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem })
    const ctx = await runtimeContext()
    const ref = { environmentId: 'local', sessionId: 'one' }

    ctx.environmentNavigation.presentation.update(ref, { draft: 'one' })
    ctx.environmentNavigation.presentation.update(ref, { draft: 'two' })
    ctx.environmentNavigation.presentation.update(ref, { draft: 'latest' })
    expect(setItem).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(249)
    expect(setItem).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem.mock.calls[0]?.[1]).toContain('latest')
    await ctx.fiber.dispose()
  })

  test('flushes a pending presentation on pagehide without a later duplicate', async () => {
    vi.useFakeTimers()
    const setItem = vi.fn()
    const page = new EventTarget()
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem })
    vi.stubGlobal('addEventListener', page.addEventListener.bind(page))
    vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page))
    const ctx = await runtimeContext()
    ctx.environmentNavigation.presentation.update(
      { environmentId: 'local', sessionId: 'one' },
      { draft: 'leaving' },
    )

    page.dispatchEvent(new Event('pagehide'))
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem.mock.calls[0]?.[1]).toContain('leaving')
    await vi.advanceTimersByTimeAsync(250)
    expect(setItem).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  test('flushes a pending presentation when the runtime is disposed', async () => {
    vi.useFakeTimers()
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem })
    const ctx = await runtimeContext()
    ctx.environmentNavigation.presentation.update(
      { environmentId: 'local', sessionId: 'one' },
      { draft: 'dispose me' },
    )

    await ctx.fiber.dispose()
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem.mock.calls[0]?.[1]).toContain('dispose me')
    await vi.advanceTimersByTimeAsync(250)
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  test('provides the exact feature service used by client plugins', async () => {
    const ctx = new Context()
    const fetch = vi.fn(async () => new Response('local'))
    vi.stubGlobal('fetch', fetch)
    ctx.provide('connection', {
      generation: { getSnapshot: () => ({ id: 7 }), subscribe: () => () => {} },
    } as ConnectionHandle)
    ctx.provide('connectionFactory', { create: vi.fn() } as ConnectionFactory)

    await ctx.plugin({ apply, inject })
    const unregister = ctx.environmentRuntime.registerFeatureRoute('/api/tasks')
    await ctx.environmentRuntime.request('/api/tasks', { method: 'GET' })

    expect(ctx.environmentRuntime.environmentId).toBe('local')
    expect(ctx.environmentComposition).toBeDefined()
    expect(ctx.environmentNavigation.presentation.get({ environmentId: 'local', sessionId: 'one' }))
      .toMatchObject({ draft: '', viewId: 'chat' })
    expect(ctx.environmentRuntime.generation.getSnapshot()).toMatchObject({
      environmentId: 'local',
      generation: 7,
    })
    expect(fetch).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({ method: 'GET' }))
    unregister()
    await ctx.fiber.dispose()
  })
})
