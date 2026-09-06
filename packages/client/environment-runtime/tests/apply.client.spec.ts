import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ConnectionFactory, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('local environment runtime plugin', () => {
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
