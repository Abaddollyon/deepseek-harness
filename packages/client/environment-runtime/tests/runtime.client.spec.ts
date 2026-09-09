import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createEnvironmentRuntime } from '../src/client/runtime.ts'

describe('environment runtime activation', () => {
  test('activates complete service trees in independent root contexts', async () => {
    const seen: string[] = []
    const activate = vi.fn(async (ctx: Context) => {
      const environment = ctx.environmentRuntime
      ctx.provide('schemaFixture', { environmentId: environment.environmentId })
      ctx.on('fixture/event', (value: string) => { seen.push(`${environment.environmentId}:${value}`) })
    })
    const request = vi.fn(async (environmentId: string) => new Response(environmentId))

    const local = await createEnvironmentRuntime({ environmentId: 'local', activate, request })
    const sigil = await createEnvironmentRuntime({ environmentId: 'sigil', activate, request })

    expect(local.context).not.toBe(sigil.context)
    expect(local.context.get('schemaFixture')).toEqual({ environmentId: 'local' })
    expect(sigil.context.get('schemaFixture')).toEqual({ environmentId: 'sigil' })
    local.context.emit('fixture/event', 'one')
    sigil.context.emit('fixture/event', 'two')
    expect(seen).toEqual(['local:one', 'sigil:two'])
    expect(activate).toHaveBeenCalledTimes(2)

    await local.dispose()
    sigil.context.emit('fixture/event', 'still-live')
    expect(seen.at(-1)).toBe('sigil:still-live')
    await sigil.dispose()
  })

  test('installs the runtime-owned Connection before activating feature plugins', async () => {
    const value = await createEnvironmentRuntime({
      environmentId: 'sigil',
      request: async () => new Response('feature'),
      connectionTransport: {
        fetch: async (_url, init) => {
          const request = JSON.parse(await new Response(init.body).text()) as { rpcId: string }
          return new Response(JSON.stringify({
            type: 'server-response',
            rpcId: request.rpcId,
            result: { ok: true, value: 'sigil-rpc' },
          }))
        },
      },
      createConnection: createConnectionHandle,
      activate: async (ctx) => {
        const connection = ctx.get('connection') as ReturnType<typeof createConnectionHandle>
        const result = await connection.rpc.call('/api', 'fixture/read', {})
        ctx.provide('transportFixture', result)
      },
    })

    expect(value.context.get('transportFixture')).toEqual({ ok: true, value: 'sigil-rpc' })
    await value.dispose()
  })

  test('publishes runtime identity and fences requests after generation changes', async () => {
    let finish!: (response: Response) => void
    let generation = 1
    const listeners = new Set<() => void>()
    const value = await createEnvironmentRuntime({
      environmentId: 'sigil',
      activate: async () => {},
      request: () => new Promise((resolve) => { finish = resolve }),
      generation: {
        getSnapshot: () => generation,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    })
    value.request.registerRoute('/api/tasks')

    const pending = value.request.request('/api/tasks')
    generation = 2
    for (const listener of listeners) listener()
    finish(new Response('old'))

    expect(value.context.environmentRuntime.environmentId).toBe('sigil')
    expect(value.context.environmentRuntime.runtimeId).toBe(value.runtimeId)
    await expect(pending).rejects.toThrow('generation changed')
    await value.dispose()
  })
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    schemaFixture: { environmentId: string }
    transportFixture: unknown
  }
  interface Events {
    'fixture/event'(value: string): void
  }
}
