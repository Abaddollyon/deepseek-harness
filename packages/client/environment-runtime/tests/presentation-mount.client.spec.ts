import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createEnvironmentPresentationMount } from '../src/client/presentation-mount.ts'
import { createEnvironmentRuntime } from '../src/client/runtime.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })
const root = () => { const context = new Context(); roots.push(context); return context }

describe('environment presentation mount lifetime', () => {
  test('rejects pre-cancelled activation without entering its callback', async () => {
    const runtime = await createEnvironmentRuntime({ environmentId: 'remote', request: vi.fn(), activate: () => {} })
    roots.push(runtime.context)
    const activate = vi.fn()
    await expect(createEnvironmentPresentationMount({
      runtime, shell: root(), runtimeServices: [], shellServices: [], signal: AbortSignal.abort(), activate,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(activate).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  test('allows a runtime without an identity service and an activation without a disposer', async () => {
    const context = root()
    const runtime = {
      environmentId: 'custom', runtimeId: 'custom-1', context,
      request: { request: vi.fn(), registerRoute: vi.fn(), dispose: vi.fn() },
      generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
      dispose: async () => { await context.fiber.dispose() },
    }
    const mount = await createEnvironmentPresentationMount({
      runtime, shell: root(), runtimeServices: [], shellServices: [], signal: new AbortController().signal,
      activate: () => {},
    })
    expect(mount.context.get('environmentRuntime')).toBeUndefined()
    await mount.dispose()
    await mount.dispose()
  })

  test.each([
    { runtimeServices: ['environmentRuntime'], shellServices: ['environmentRuntime'], message: 'projected by both' },
    { runtimeServices: ['missing'], shellServices: [], message: 'runtime service "missing" is unavailable' },
    { runtimeServices: [], shellServices: ['missing'], message: 'shell service "missing" is unavailable' },
  ])('rejects unavailable or ambiguous service projection: $message', async ({ runtimeServices, shellServices, message }) => {
    const runtime = await createEnvironmentRuntime({ environmentId: 'remote', request: vi.fn(), activate: () => {} })
    roots.push(runtime.context)
    try {
      const activate = vi.fn()
      await expect(createEnvironmentPresentationMount({
        runtime, shell: root(), runtimeServices, shellServices, signal: new AbortController().signal, activate,
      })).rejects.toThrow(message)
      expect(activate).not.toHaveBeenCalled()
    } finally { await runtime.dispose() }
  })

  test('late cancellation disposes activation and Cordis effects before rejecting', async () => {
    const runtime = await createEnvironmentRuntime({ environmentId: 'remote', request: vi.fn(), activate: () => {} })
    roots.push(runtime.context)
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const effectCleanup = vi.fn()
    const activationCleanup = vi.fn()
    const pending = createEnvironmentPresentationMount({
      runtime, shell: root(), runtimeServices: [], shellServices: [], signal: controller.signal,
      async activate(ctx) { ctx.effect(() => effectCleanup); entered.resolve(undefined); await finish.promise; return activationCleanup },
    })
    await entered.promise
    controller.abort()
    finish.resolve(undefined)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(activationCleanup).toHaveBeenCalledOnce()
    expect(effectCleanup).toHaveBeenCalledOnce()
    await runtime.dispose()
  })
})
