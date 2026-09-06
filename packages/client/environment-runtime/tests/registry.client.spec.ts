import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import {
  createEnvironmentRuntimeRegistry,
  type EnvironmentRuntime,
} from '../src/client/registry.ts'

function runtime(environmentId: string): EnvironmentRuntime {
  const context = new Context()
  return {
    environmentId,
    runtimeId: `${environmentId}-runtime`,
    context,
    generation: {
      getSnapshot: () => ({ environmentId, runtimeId: `${environmentId}-runtime`, generation: 1 }),
      subscribe: () => () => {},
    },
    request: { request: vi.fn() },
    dispose: vi.fn(async () => { await context.fiber.dispose() }),
  }
}

describe('environment runtime registry', () => {
  test('keeps host contexts independent and releases only the final lease', async () => {
    const created = new Map<string, EnvironmentRuntime>()
    const registry = createEnvironmentRuntimeRegistry({
      createRuntime: async (environmentId) => {
        const value = runtime(environmentId)
        created.set(environmentId, value)
        return value
      },
    })

    const localA = await registry.acquire('local')
    const localB = await registry.acquire('local')
    const remote = await registry.acquire('sigil')

    expect(localA.runtime).toBe(localB.runtime)
    expect(localA.runtime.context).not.toBe(remote.runtime.context)
    await localA.release()
    expect(localA.runtime.dispose).not.toHaveBeenCalled()
    await localB.release()
    expect(localA.runtime.dispose).toHaveBeenCalledOnce()
    expect(remote.runtime.dispose).not.toHaveBeenCalled()
    await remote.release()
  })

  test('deduplicates concurrent creation and disposes a late created runtime after registry shutdown', async () => {
    let resolve!: (value: EnvironmentRuntime) => void
    const pending = new Promise<EnvironmentRuntime>((accept) => { resolve = accept })
    const createRuntime = vi.fn(() => pending)
    const registry = createEnvironmentRuntimeRegistry({ createRuntime })

    const first = registry.acquire('sigil')
    const second = registry.acquire('sigil')
    const disposing = registry.dispose()
    const value = runtime('sigil')
    resolve(value)

    await expect(first).rejects.toThrow('disposed')
    await expect(second).rejects.toThrow('disposed')
    await disposing
    expect(createRuntime).toHaveBeenCalledOnce()
    expect(value.dispose).toHaveBeenCalledOnce()
  })

  test('reacquires a fresh runtime while the prior zero-reference runtime is disposing', async () => {
    let finishDispose!: () => void
    const created: EnvironmentRuntime[] = []
    const registry = createEnvironmentRuntimeRegistry({
      createRuntime: async (environmentId) => {
        const value = runtime(environmentId)
        if (created.length === 0) {
          Object.defineProperty(value, 'dispose', {
            value: vi.fn(() => new Promise<void>((resolve) => { finishDispose = resolve })),
          })
        }
        created.push(value)
        return value
      },
    })
    const first = await registry.acquire('sigil')
    const releasing = first.release()
    const second = await registry.acquire('sigil')
    expect(second.runtime).not.toBe(first.runtime)
    expect(created).toHaveLength(2)
    finishDispose()
    await releasing
    await second.release()
  })
})
