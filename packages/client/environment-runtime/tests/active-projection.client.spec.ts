import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import {
  createActiveEnvironmentRuntimeProjection,
  type EnvironmentSelectionSource,
} from '../src/client/active-projection.ts'
import { createEnvironmentRuntimeRegistry, type EnvironmentRuntime } from '../src/client/registry.ts'

function selection(initial: string): EnvironmentSelectionSource & { set(value: string): void } {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(value) {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
}

function fakeRuntime(environmentId: string): EnvironmentRuntime {
  const context = new Context()
  context.provide('projectionFixture', { environmentId })
  return {
    environmentId,
    runtimeId: `${environmentId}-runtime`,
    context,
    request: { request: vi.fn(), registerRoute: vi.fn(() => () => {}), dispose: vi.fn() },
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    dispose: vi.fn(async () => { await context.fiber.dispose() }),
  }
}

function source<T>(initial: T): {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
} {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(value) { current = value; for (const listener of [...listeners]) listener() },
  }
}

describe('active environment runtime projection', () => {
  test('keeps one owning-runtime UI registration active in the shell', async () => {
    const selected = selection('local')
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: async id => fakeRuntime(id) })
    const shell = new Map<string, string>()
    const activate = vi.fn(async (runtime: EnvironmentRuntime) => {
      const service = runtime.context.get('projectionFixture') as { environmentId: string }
      shell.set('content', service.environmentId)
      return () => { if (shell.get('content') === service.environmentId) shell.delete('content') }
    })
    const projection = createActiveEnvironmentRuntimeProjection({
      registry,
      selection: selected,
      activate,
    })
    await projection.whenIdle()
    expect(shell.get('content')).toBe('local')

    selected.set('sigil')
    await projection.whenIdle()
    expect(shell.get('content')).toBe('sigil')
    expect(activate).toHaveBeenCalledTimes(2)
    expect(projection.getSnapshot()).toMatchObject({
      phase: 'ready', environmentId: 'sigil', activeEnvironmentId: 'sigil',
    })

    selected.set('sigil')
    await projection.whenIdle()
    expect(shell.get('content')).toBe('sigil')

    await projection.dispose()
    expect(shell.size).toBe(0)
  })

  test('reports the committed UI owner separately from a failed navigation target', async () => {
    const selected = selection('local')
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: async id => fakeRuntime(id) })
    const projection = createActiveEnvironmentRuntimeProjection({
      registry,
      selection: selected,
      activate: async (runtime) => {
        if (runtime.environmentId === 'sigil') throw new Error('mount failed')
        return () => {}
      },
    })
    await projection.whenIdle()
    expect(projection.getSnapshot()).toMatchObject({ activeEnvironmentId: 'local' })

    selected.set('sigil')
    await projection.whenIdle()
    expect(projection.getSnapshot()).toMatchObject({ phase: 'error', environmentId: 'sigil' })
    expect(projection.getSnapshot().activeEnvironmentId).toBeUndefined()
    await projection.dispose()
  })

  test('disposes late activation without replacing a newer selected Host', async () => {
    const selected = selection('local')
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: async id => fakeRuntime(id) })
    let finishLocal!: () => void
    const localReady = new Promise<void>((resolve) => { finishLocal = resolve })
    const active: string[] = []
    const entered: string[] = []
    const disposed: string[] = []
    const projection = createActiveEnvironmentRuntimeProjection({
      registry,
      selection: selected,
      activate: async (runtime) => {
        entered.push(runtime.environmentId)
        if (runtime.environmentId === 'local') await localReady
        active.push(runtime.environmentId)
        return () => { disposed.push(runtime.environmentId) }
      },
    })

    await vi.waitFor(() => { expect(entered).toContain('local') })
    selected.set('sigil')
    finishLocal()
    await projection.whenIdle()
    await vi.waitFor(() => { expect(disposed).toContain('local') })
    const snapshot = projection.getSnapshot()
    expect(snapshot.phase === 'ready' ? snapshot.environmentId : undefined).toBe('sigil')
    await projection.dispose()
  })

  test('serializes rapid Host transitions so presentation graphs never overlap', async () => {
    const selected = selection('local')
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: async id => fakeRuntime(id) })
    let finishLocal!: () => void
    const localReady = new Promise<void>((resolve) => { finishLocal = resolve })
    let activeCount = 0
    let maxActiveCount = 0
    const projection = createActiveEnvironmentRuntimeProjection({
      registry,
      selection: selected,
      activate: async (runtime) => {
        activeCount += 1
        maxActiveCount = Math.max(maxActiveCount, activeCount)
        if (runtime.environmentId === 'local') await localReady
        return () => { activeCount -= 1 }
      },
    })
    await vi.waitFor(() => { expect(activeCount).toBe(1) })

    selected.set('sigil')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(maxActiveCount).toBe(1)
    finishLocal()
    await projection.whenIdle()
    expect(maxActiveCount).toBe(1)
    expect(projection.getSnapshot()).toMatchObject({ phase: 'ready', environmentId: 'sigil' })
    await projection.dispose()
  })

  test('keeps the mounted runtime while connection loss becomes retryable state', async () => {
    const selected = selection('sigil')
    const generation = source<EnvironmentRuntime['generation']['getSnapshot'] extends () => infer T ? T : never>(undefined)
    const connectionState = source<'connecting' | 'connected' | 'disconnected' | undefined>('connecting')
    const reconnect = vi.fn()
    const runtime = fakeRuntime('sigil')
    Object.defineProperty(runtime, 'generation', { value: generation })
    runtime.context.reflect.provide('connection', { state: connectionState, reconnect })
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: async () => runtime })
    const activationDispose = vi.fn()
    const projection = createActiveEnvironmentRuntimeProjection({
      registry,
      selection: selected,
      now: () => 42_000,
      activate: vi.fn(() => activationDispose),
    })
    await projection.whenIdle()
    expect(projection.getSnapshot()).toMatchObject({
      phase: 'ready', environmentId: 'sigil', connectionState: 'connecting',
    })
    const mounted = projection.getSnapshot()
    expect(mounted.phase === 'ready' && mounted.runtime === runtime).toBe(true)

    generation.set({ environmentId: 'sigil', runtimeId: runtime.runtimeId, generation: 1 })
    connectionState.set('connected')
    expect(projection.getSnapshot()).toMatchObject({
      phase: 'ready', connectionState: 'connected', lastConnectedAt: 42_000,
    })

    generation.set(undefined)
    connectionState.set('disconnected')
    expect(projection.getSnapshot()).toMatchObject({
      phase: 'ready', connectionState: 'disconnected', lastConnectedAt: 42_000,
    })

    projection.retry()
    expect(reconnect).toHaveBeenCalledOnce()
    expect(activationDispose).not.toHaveBeenCalled()
    expect(projection.getSnapshot()).toMatchObject({
      phase: 'ready', connectionState: 'connecting', lastConnectedAt: 42_000,
    })
    await projection.dispose()
  })

  test('releases the runtime lease when presentation cleanup throws', async () => {
    const selected = selection('sigil')
    const runtime = fakeRuntime('sigil')
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: async () => runtime })
    const projection = createActiveEnvironmentRuntimeProjection({
      registry,
      selection: selected,
      activate: () => () => { throw new Error('presentation cleanup failed') },
    })
    await projection.whenIdle()

    await expect(projection.dispose()).rejects.toThrow('presentation cleanup failed')
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  test('settles to idle after a selected presentation cleanup failure', async () => {
    const selected = source<string | undefined>('sigil')
    const runtime = fakeRuntime('sigil')
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: async () => runtime })
    const projection = createActiveEnvironmentRuntimeProjection({
      registry,
      selection: selected,
      activate: () => () => { throw new Error('presentation cleanup failed') },
    })
    await projection.whenIdle()

    selected.set(undefined)
    await expect(projection.whenIdle()).rejects.toThrow('presentation cleanup failed')
    expect(projection.getSnapshot()).toEqual({ phase: 'idle' })
    expect(runtime.dispose).toHaveBeenCalledOnce()
    await expect(projection.dispose()).rejects.toThrow('presentation cleanup failed')
  })
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    projectionFixture: { environmentId: string }
  }
}
