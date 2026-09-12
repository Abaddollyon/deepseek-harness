import { Context } from '@deepseek-ai/cordis'
import { createConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createEnvironmentNavigation } from '../src/client/navigation.ts'
import {
  createEnvironmentCompositionService, type EnvironmentCompositionOptions,
  type EnvironmentComposition, type EnvironmentAppLocation,
} from '../src/client/composition.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
function fixture() {
  const shell = new Context()
  cleanups.push(() => shell.fiber.dispose())
  const navigation = createEnvironmentNavigation({ kind: 'environments' })
  const removeNavigation = shell.reflect.provide('environmentNavigation', navigation)
  const removeRuntime = shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
  const removeFactory = shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
  const service = createEnvironmentCompositionService(shell)
  const carrierDispose = vi.fn()
  const request = vi.fn(async () => new Response('remote feature'))
  const carrier = async () => ({ request, connectionTransport: { fetch: vi.fn() }, dispose: carrierDispose })
  const options: EnvironmentCompositionOptions = {
    navigation,
    domain: { roots: ['domain'] }, presentation: { roots: ['presentation'] }, runtimeServices: [], shellServices: [],
    activator: {
      deriveRoster: roots => [...roots],
      activate: async () => ({ dispose: async () => {} }),
      withdraw: async () => ({ resume: async () => {} }),
    },
  }
  const start = async (next = options): Promise<EnvironmentComposition> => {
    const composition = await service.start(next)
    cleanups.push(() => composition.dispose())
    return composition
  }
  return { shell, navigation, service, carrier, carrierDispose, request, options, start, removeNavigation, removeRuntime, removeFactory }
}
async function connectedFixture(activatePresentation = async (_context: Context) => ({ dispose: async () => {} })) {
  const f = fixture()
  const ready = Promise.withResolvers<() => void>()
  f.service.registerFactory(f.carrier)
  const composition = await f.start({ ...f.options, activator: {
    ...f.options.activator,
    activate: async (ctx, ids) => {
      if (ids.includes('presentation')) return activatePresentation(ctx)
      const connection = ctx.get('connection') as ConnectionHandle
      ctx.effect(() => connection.registerGenerationSource(async (signal, publish) => {
        ready.resolve(() => { publish({ home: '/remote' }) })
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }))
      const loop = connection.start({})
      ctx.effect(() => () => { loop.stop() })
      return { dispose: async () => {} }
    },
  } })
  return { ...f, composition, ready: ready.promise }
}

const remote: EnvironmentAppLocation = { kind: 'session', ref: { environmentId: 'remote', sessionId: 'one' }, viewId: 'chat' }
const local: EnvironmentAppLocation = { kind: 'environments' }

describe('environment composition failure and cancellation', () => {
  test('contains repeated withdrawal after a superseded presentation cleanup fails', async () => {
    const f = fixture()
    const failure = new Error('presentation cleanup failed')
    const resume = vi.fn(async () => {})
    const cleanup = vi.fn(async () => { throw failure })
    f.service.registerFactory(f.carrier)
    const composition = await f.start({ ...f.options, activator: {
      ...f.options.activator,
      withdraw: async () => ({ resume }),
      activate: async (ctx, ids) => {
        if (ids.includes('domain')) {
          ctx.reflect.provide('sessions', {
            list: { getSnapshot: () => ({ byId: { one: {} } }), subscribe: () => () => {} },
            open: () => { f.navigation.open(local) },
          })
          return { dispose: async () => {} }
        }
        return { dispose: cleanup }
      },
    } })
    f.navigation.open(remote)
    await composition.whenIdle()
    await composition.whenIdle()
    expect(composition.getSnapshot()).toEqual({ phase: 'idle' })
    expect(cleanup).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledTimes(2)
    expect(f.carrierDispose).toHaveBeenCalledOnce()
  })

  test('contains a copied readiness notification after its waiter is cancelled', async () => {
    const f = await connectedFixture()
    const controller = new AbortController()
    const failure = new Error('cancelled by readiness observer')
    cleanups.push(f.composition.subscribe(() => {
      const state = f.composition.getSnapshot()
      if (state.phase === 'ready' && state.connectionState === 'connected') controller.abort(failure)
    }))
    const callback = vi.fn()
    const pending = f.service.withPresentation(remote, callback, { signal: controller.signal })
    const rejected = expect(pending).rejects.toBe(failure)
    await f.composition.whenIdle()
    await new Promise<void>(resolve => setImmediate(resolve))
    const connect = await f.ready
    connect()
    await rejected
    expect(callback).not.toHaveBeenCalled()
  })

  test('keeps a pending waiter contained when an earlier navigation observer throws during a Host switch', async () => {
    const f = await connectedFixture()
    const failure = new Error('navigation observer failed')
    let throwOnNavigation = false
    cleanups.push(f.navigation.subscribe(() => {
      if (throwOnNavigation) throw failure
    }))
    const controller = new AbortController()
    const callback = vi.fn()
    const pending = f.service.withPresentation(remote, callback, { signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('cancel pending waiter')
    await f.composition.whenIdle()
    await new Promise<void>(resolve => setImmediate(resolve))
    throwOnNavigation = true
    expect(() => { f.navigation.open(local) }).toThrow(failure)
    await f.composition.whenIdle()
    controller.abort(new Error('cancel pending waiter'))
    await rejected
    expect(callback).not.toHaveBeenCalled()
  })

  test('rejects local callbacks when synchronous navigation redirects to a remote presentation', async () => {
    const f = await connectedFixture()
    cleanups.push(f.navigation.subscribe(() => {
      if (f.navigation.getSnapshot().kind === 'new-session') f.navigation.open(remote)
    }))
    const callback = vi.fn()
    const pending = f.service.withPresentation(
      { kind: 'new-session', environmentId: 'local', viewId: 'chat' }, callback,
    )
    const rejected = expect(pending).rejects.toThrow('local presentation is not restored')
    const connect = await f.ready
    connect()
    await rejected
    expect(f.composition.getSnapshot().phase).toBe('ready')
    expect(callback).not.toHaveBeenCalled()
  })

  test('rejects callback results after a retry replaces the presentation without changing its Host generation', async () => {
    const f = await connectedFixture()
    const pending = f.service.withPresentation(remote, async () => {
      f.composition.retry()
      await f.composition.whenIdle()
      return 'stale presentation'
    })
    const rejected = expect(pending).rejects.toThrow('destination Host is not connected')
    const connect = await f.ready
    connect()
    await rejected
  })

  test.each(['resolve', 'reject'] as const)('ignores stale refresh %s and permits retry after the current refresh settles', async (settlement) => {
    const f = fixture()
    const listeners = new Set<() => void>()
    const pending: Array<ReturnType<typeof Promise.withResolvers<undefined>>> = []
    const refresh = vi.fn(() => { const item = Promise.withResolvers<undefined>(); pending.push(item); return item.promise })
    const list = {
      getSnapshot: () => ({ current: undefined, byId: {} }),
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    f.shell.reflect.provide('sessions', { list, open: vi.fn(), clear: vi.fn(), refresh })
    f.service.registerFactory(f.carrier)
    await f.start()
    const one: EnvironmentAppLocation = { kind: 'session', ref: { environmentId: 'local', sessionId: 'one' }, viewId: 'chat' }
    const two: EnvironmentAppLocation = { kind: 'session', ref: { environmentId: 'local', sessionId: 'two' }, viewId: 'chat' }
    f.navigation.open({ kind: 'new-session', environmentId: 'local', viewId: 'chat' })
    f.navigation.open(one)
    f.navigation.open(two)
    expect(refresh).toHaveBeenCalledTimes(2)
    if (settlement === 'resolve') pending[0]!.resolve(undefined)
    else pending[0]!.reject(new Error('stale refresh'))
    await Promise.resolve(undefined)
    f.navigation.open(two)
    expect(refresh).toHaveBeenCalledTimes(2)
    pending[1]!.reject(new Error('current refresh'))
    await Promise.resolve(undefined)
    f.navigation.open(two)
    expect(refresh).toHaveBeenCalledTimes(3)
    pending[2]!.resolve(undefined)
    await Promise.resolve(undefined)
  })

  test('copied navigation callbacks are inert after composition disposal', async () => {
    const f = fixture()
    const open = vi.fn()
    f.shell.reflect.provide('sessions', {
      open, list: { getSnapshot: () => ({ current: undefined, byId: { one: {} } }), subscribe: () => () => {} },
    })
    f.service.registerFactory(f.carrier)
    const owner: { composition?: EnvironmentComposition } = {}
    let dispose: Promise<void> | undefined
    const off = f.navigation.subscribe(() => { dispose = owner.composition?.dispose() })
    cleanups.push(off)
    const composition = await f.start()
    owner.composition = composition
    f.navigation.open({ kind: 'session', ref: { environmentId: 'local', sessionId: 'one' }, viewId: 'chat' })
    await dispose
    expect(open).not.toHaveBeenCalled()
  })

  test('factory ownership prevents duplicate registration and ignores an old disposer', async () => {
    const f = fixture()
    await expect(f.start()).rejects.toThrow('no carrier factory')
    const offFirst = f.service.registerFactory(f.carrier)
    expect(() => f.service.registerFactory(f.carrier)).toThrow('already registered')
    offFirst()
    const offSecond = f.service.registerFactory(async () => f.carrier())
    offFirst()
    const composition = await f.start()
    await expect(f.start()).rejects.toThrow('already running')
    await composition.dispose()
    await composition.dispose()
    offSecond()
    await expect(f.start()).rejects.toThrow('no carrier factory')
  })

  test('failed startup releases the running reservation so configuration can be corrected', async () => {
    const f = fixture()
    f.service.registerFactory(f.carrier)
    await f.removeFactory()
    await expect(f.start()).rejects.toThrow('Connection factory is unavailable')
    f.shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const composition = await f.start()
    await composition.whenIdle()
    expect(composition.getSnapshot()).toEqual({ phase: 'idle' })
  })

  test('local presentation requires navigation and the matching runtime', async () => {
    const f = fixture()
    await f.removeNavigation()
    await expect(f.service.withPresentation(local, vi.fn())).rejects.toThrow('navigation is unavailable')
    f.shell.reflect.provide('environmentNavigation', f.navigation)
    await f.removeRuntime()
    await expect(f.service.withPresentation(local, vi.fn())).rejects.toThrow('local runtime is unavailable')
    f.shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    await expect(f.service.withPresentation(local, context => context === f.shell)).resolves.toBe(true)
    f.service.registerFactory(f.carrier)
    await f.start({ ...f.options, localEnvironmentId: 'another-local' })
    await expect(f.service.withPresentation(local, vi.fn())).rejects.toThrow('local runtime is unavailable')
  })

  test('rejects disconnected local generations and a pre-cancelled non-Error caller reason', async () => {
    const f = fixture()
    await f.removeRuntime()
    f.shell.reflect.provide('environmentRuntime', { environmentId: 'local', generation: { getSnapshot: () => undefined } })
    const callback = vi.fn()
    await expect(f.service.withPresentation(local, callback)).rejects.toThrow('destination Host is not connected')
    await expect(f.service.withPresentation(local, callback, { signal: AbortSignal.abort('cancelled') })).rejects.toMatchObject({ name: 'AbortError' })
    expect(callback).not.toHaveBeenCalled()
  })

  test('caller cancellation while startup is pending does not cancel the shared composition', async () => {
    const f = fixture()
    f.service.registerFactory(f.carrier)
    const requirements = Promise.withResolvers<readonly string[]>()
    const starting = f.start({ ...f.options, activator: { ...f.options.activator, serviceRequirements: () => requirements.promise } })
    await expect(f.service.withPresentation(local, vi.fn(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    requirements.resolve([])
    await starting
    await expect(f.service.withPresentation(local, context => context === f.shell)).resolves.toBe(true)
  })

  test('rejects a delayed startup waiter when the composition is disposed before it enters', async () => {
    const f = fixture()
    f.service.registerFactory(f.carrier)
    const requirements = Promise.withResolvers<readonly string[]>()
    const starting = f.service.start({
      ...f.options,
      activator: { ...f.options.activator, serviceRequirements: () => requirements.promise },
    })
    const disposing = starting.then(composition => composition.dispose())
    const callback = vi.fn()
    const waiting = f.service.withPresentation(local, callback, { signal: new AbortController().signal })
    requirements.resolve([])
    await expect(waiting).rejects.toThrow('composition is disposed')
    await disposing
    expect(callback).not.toHaveBeenCalled()
  })

  test('rejects a stale result when an earlier navigation listener throws before cancellation is delivered', async () => {
    const f = fixture()
    const failure = new Error('navigation observer failed')
    let initial = true
    cleanups.push(f.navigation.subscribe(() => {
      if (initial) { initial = false; return }
      throw failure
    }))
    await expect(f.service.withPresentation(local, (_context, signal) => {
      expect(() => { f.navigation.open({ kind: 'new-session', environmentId: 'local', viewId: 'chat' }) }).toThrow(failure)
      expect(signal.aborted).toBe(false)
      return 'stale result'
    })).rejects.toThrow('navigation was superseded')
    expect(f.navigation.getSnapshot().kind).toBe('new-session')
  })

  test('a callback that cancels synchronously cannot acknowledge its result', async () => {
    const f = fixture()
    const controller = new AbortController()
    const reason = new Error('cancelled during callback')
    let callbackSignal: AbortSignal | undefined
    await expect(f.service.withPresentation(local, (_context, signal) => {
      callbackSignal = signal
      controller.abort(reason)
      expect(signal.aborted).toBe(true)
      return 'late'
    }, { signal: controller.signal })).rejects.toBe(reason)
    expect(callbackSignal?.reason).toBe(reason)
    await new Promise<void>(resolve => setImmediate(resolve))
  })

  test('remote domain activation failure releases the carrier and rejects presentation resolution', async () => {
    const f = fixture()
    f.service.registerFactory(f.carrier)
    const failure = new Error('domain unavailable')
    const composition = await f.start({ ...f.options, activator: {
      ...f.options.activator,
      activate: async () => { throw failure },
    } })
    const changed = vi.fn()
    const off = composition.subscribe(changed)
    await expect(f.service.withPresentation(remote, vi.fn())).rejects.toMatchObject({ message: 'environment composition: destination activation failed', cause: failure })
    expect(changed).toHaveBeenCalled()
    expect(f.carrierDispose).toHaveBeenCalledOnce()
    off()
  })

  test('projects discovered runtime dependencies and uses the bound carrier for feature requests', async () => {
    const f = fixture()
    f.service.registerFactory(f.carrier)
    const resume = vi.fn(async () => {})
    const withdrawn = vi.fn(async (_context: Context, ids: readonly string[]) => { expect(ids).toEqual(['suspended']); return { resume } })
    let remoteContext: Context | undefined
    const composition = await f.start({ ...f.options,
      suspension: { roots: ['suspended'] },
      activator: {
        ...f.options.activator,
        serviceRequirements: async () => ['remoteFixture'],
        withdraw: withdrawn,
        activate: async (ctx, ids) => {
          if (ids.includes('domain')) {
            ctx.reflect.provide('remoteFixture', { owner: 'remote' })
            const connection = ctx.get('connection') as ConnectionHandle
            ctx.effect(() => connection.registerGenerationSource(async (signal, ready) => {
              ready({ home: '/remote' })
              await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
            }))
            const loop = connection.start({})
            ctx.effect(() => () => { loop.stop() })
          } else {
            remoteContext = ctx
            expect(ctx.get('remoteFixture')).toEqual({ owner: 'remote' })
          }
          return { dispose: async () => {} }
        },
      },
    })
    await f.service.withPresentation(remote, async (ctx) => {
      const off = ctx.environmentRuntime.registerFeatureRoute('/api/feature')
      try { expect(await (await ctx.environmentRuntime.request('/api/feature')).text()).toBe('remote feature') }
      finally { off() }
    })
    expect(remoteContext).toBeDefined()
    expect(f.request).toHaveBeenCalledWith('/api/feature', expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }))
    const runtime = composition.getSnapshot()
    expect(runtime.phase).toBe('ready')
    if (runtime.phase !== 'ready') throw new Error('fixture did not mount')
    await runtime.runtime.dispose()
    await runtime.runtime.dispose()
    expect(f.carrierDispose).toHaveBeenCalledOnce()
  })

  test('ignores Session events after the local location follower is disposed', async () => {
    const f = fixture()
    const listeners = new Set<() => void>()
    const open = vi.fn()
    f.shell.reflect.provide('sessions', {
      open,
      list: {
        getSnapshot: () => ({ current: undefined, byId: {} }),
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    })
    f.service.registerFactory(f.carrier)
    const composition = await f.start()
    const saved = [...listeners][0]
    await composition.dispose()
    saved?.()
    expect(open).not.toHaveBeenCalled()
  })

  test('ignores Session events owned by another environment', async () => {
    const f = fixture()
    const localOpen = vi.fn()
    const listeners = new Set<() => void>()
    f.shell.reflect.provide('sessions', {
      open: localOpen,
      list: {
        getSnapshot: () => ({ current: undefined, byId: {} }),
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    })
    f.service.registerFactory(f.carrier)
    const composition = await f.start()
    f.navigation.open({ kind: 'session', ref: { environmentId: 'remote', sessionId: 'same' }, viewId: 'chat' })
    await composition.whenIdle()
    for (const listener of listeners) listener()
    expect(localOpen).not.toHaveBeenCalled()
    await composition.dispose()
  })
})
