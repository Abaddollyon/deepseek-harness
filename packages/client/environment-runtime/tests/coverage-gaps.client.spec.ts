import { describe, expect, test, vi } from 'vitest'
import { createEnvironmentNavigation, environmentSelection } from '../src/client/navigation.ts'
import { createEnvironmentRequest } from '../src/client/request.ts'
import { createEnvironmentRuntimeRegistry } from '../src/client/registry.ts'
import { createEnvironmentRuntime } from '../src/client/runtime.ts'
import { failureAfterCleanup, runCleanupSteps } from '../src/client/cleanup.ts'

const flush = () => new Promise<void>((resolve) => { queueMicrotask(resolve) })

describe('environment runtime coverage behaviors', () => {
  test('navigation snapshots, history, readiness supersession, and selection', async () => {
    const nav = createEnvironmentNavigation({ kind: 'environments', selectedId: 'local' })
    const listener = vi.fn()
    const off = nav.subscribe(listener)
    const pending = Promise.withResolvers<undefined>()
    const opening = nav.openWhen(pending.promise, { kind: 'new-session', environmentId: 'sigil', viewId: 'chat' })
    nav.open({ kind: 'session', ref: { environmentId: 'local', sessionId: 'one' }, viewId: 'chat' })
    pending.resolve(undefined)
    await opening
    expect(nav.getSnapshot()).toMatchObject({ kind: 'session' })
    expect(nav.canBackToSession()).toBe(true)
    nav.back()
    expect(nav.getSnapshot()).toMatchObject({ kind: 'environments' })
    nav.backToSession()
    expect(nav.getSnapshot()).toMatchObject({ kind: 'session' })
    expect(environmentSelection(nav).getSnapshot()).toBe('local')
    off()
    expect(listener).toHaveBeenCalled()
  })

  test('request authorizes routes, composes cancellation, and fences disposal and generations', async () => {
    let generation: number | undefined = 1
    let resolve!: (response: Response) => void
    const carrier = vi.fn((_id: string, path: string, init: RequestInit) => {
      expect(path).toBe('/api/tasks?id=1')
      expect(init.signal?.aborted).toBe(false)
      return new Promise<Response>((done) => { resolve = done })
    })
    const request = createEnvironmentRequest({ environmentId: 'local', request: carrier, generation: () => generation })
    expect(() => request.registerRoute('/tasks')).toThrow('invalid registered route')
    const remove = request.registerRoute('/api/tasks/')
    const pending = request.request('/api/tasks?id=1')
    generation = 2
    resolve(new Response('late'))
    await expect(pending).rejects.toThrow('generation changed')
    remove()
    remove()
    await expect(request.request('/api/tasks')).rejects.toThrow('not registered')
    request.dispose()
    expect(() => request.registerRoute('/api/tasks')).toThrow('disposed')
    await expect(request.request('/api/tasks')).rejects.toThrow('disposed')
  })

  test('registry shares leases, handles failed creation, and disposes pending work', async () => {
    const dispose = vi.fn(async () => {})
    const runtime = { dispose, environmentId: 'local', runtimeId: 'r', context: {}, request: {}, generation: {} } as never
    const create = vi.fn(async () => runtime)
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: create })
    const [a, b] = await Promise.all([registry.acquire('local'), registry.acquire('local')])
    expect(create).toHaveBeenCalledOnce()
    expect(registry.get('local')).toBe(runtime)
    await a.release(); await a.release(); expect(dispose).not.toHaveBeenCalled()
    await b.release(); expect(dispose).toHaveBeenCalledOnce()
    await registry.dispose(); await expect(registry.acquire('local')).rejects.toThrow('disposed')

    const failed = createEnvironmentRuntimeRegistry({ createRuntime: async () => { throw new Error('boom') } })
    await expect(failed.acquire('x')).rejects.toThrow('boom')
    expect(failed.get('x')).toBeUndefined()
  })

  test('readiness commits a destination and empty history leaves the overview unchanged', async () => {
    const nav = createEnvironmentNavigation({ kind: 'environments' })
    const initial = nav.getSnapshot()
    nav.back()
    nav.backToSession()
    expect(nav.canBackToSession()).toBe(false)
    expect(nav.getSnapshot()).toBe(initial)
    const target = { kind: 'new-session' as const, environmentId: 'remote', viewId: 'chat' }
    await nav.openWhen(Promise.resolve(), target)
    expect(nav.getSnapshot()).toEqual(target)
    nav.back()
    expect(nav.getSnapshot()).toEqual(initial)
  })

  test('withdraws duplicated routes only after the last registration and tolerates withdrawal after disposal', async () => {
    const carrier = vi.fn(async () => new Response('ok'))
    const request = createEnvironmentRequest({ environmentId: 'local', request: carrier })
    const first = request.registerRoute('/api/tasks')
    const second = request.registerRoute('/api/tasks')
    first()
    await expect(request.request('/api/tasks', { signal: null })).resolves.toBeInstanceOf(Response)
    second()
    await expect(request.request('/api/tasks')).rejects.toThrow('not registered')
    const last = request.registerRoute('/api/tasks')
    request.dispose()
    expect(last).not.toThrow()
  })

  test('passes caller cancellation to transport and rejects a late response after runtime disposal', async () => {
    const reply = Promise.withResolvers<Response>()
    let signal: AbortSignal | null | undefined
    const request = createEnvironmentRequest({
      environmentId: 'remote', registeredRoutes: ['/api/tasks'],
      request: async (_environmentId, _path, init) => { signal = init.signal; return reply.promise },
    })
    const caller = new AbortController()
    const pending = request.request('/api/tasks', { signal: caller.signal })
    const reason = new Error('caller cancelled')
    caller.abort(reason)
    expect(signal?.aborted).toBe(true)
    expect(signal?.reason).toBe(reason)
    request.dispose()
    reply.resolve(new Response('late'))
    await expect(pending).rejects.toThrow('runtime is disposed')
  })

  test('rejects malformed URL escapes and normalization before transport', async () => {
    const carrier = vi.fn(async () => new Response('ok'))
    const request = createEnvironmentRequest({ environmentId: 'local', registeredRoutes: ['/api/tasks'], request: carrier })
    await expect(request.request('/api/tasks/%zz')).rejects.toThrow('invalid escaping')
    await expect(request.request('/api/tasks/\tchild')).rejects.toThrow('normalization changed')
    expect(carrier).not.toHaveBeenCalled()
    request.dispose()
  })

  test('failed concurrent acquisitions retire one entry and disposal joins a failing factory', async () => {
    const ready = Promise.withResolvers<Awaited<ReturnType<typeof createEnvironmentRuntime>>>()
    const registry = createEnvironmentRuntimeRegistry({ createRuntime: () => ready.promise })
    const a = registry.acquire('remote')
    const b = registry.acquire('remote')
    const results = Promise.allSettled([a, b])
    const disposal = registry.dispose()
    const error = new Error('activation failed')
    ready.reject(error)
    expect(await results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }])
    await disposal
    await registry.dispose()
    expect(registry.get('remote')).toBeUndefined()
  })

  test('runtime without transport has generation zero and supports explicit routes and idempotent disposal', async () => {
    const runtime = await createEnvironmentRuntime({
      environmentId: 'local', createRuntimeId: () => 'fixture-runtime', registeredRoutes: ['/api/tasks'],
      request: async () => new Response('ok'), activate: () => {},
    })
    try {
      expect(runtime.generation.getSnapshot()).toEqual({ environmentId: 'local', runtimeId: 'fixture-runtime', generation: 0 })
      const changed = vi.fn()
      const off = runtime.generation.subscribe(changed)
      off()
      await expect(runtime.request.request('/api/tasks')).resolves.toBeInstanceOf(Response)
      expect(changed).not.toHaveBeenCalled()
    } finally { await runtime.dispose() }
    await runtime.dispose()
    await expect(runtime.request.request('/api/tasks')).rejects.toThrow('disposed')
  })

  test('activation failure withdraws effects and revokes runtime requests', async () => {
    const cleanup = vi.fn()
    let request: ReturnType<typeof createEnvironmentRequest>['request'] | undefined
    const error = new Error('activation failed')
    await expect(createEnvironmentRuntime({
      environmentId: 'remote', request: async () => new Response('ok'),
      activate(ctx) {
        ctx.effect(() => cleanup)
        request = ctx.environmentRuntime.request
        ctx.environmentRuntime.registerFeatureRoute('/api/tasks')
        throw error
      },
    })).rejects.toBe(error)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(request).toBeDefined()
    await expect(request!('/api/tasks')).rejects.toThrow('disposed')
  })

  test('explicit transport requires a configured connection factory', async () => {
    await expect(createEnvironmentRuntime({
      environmentId: 'remote', request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() }, activate: vi.fn(),
    })).rejects.toThrow('explicit transport requires a Connection factory')
  })

  test('cleanup runs every step and preserves operation failures', async () => {
    const seen: string[] = []
    await expect(runCleanupSteps([
      () => { seen.push('one') },
      () => { seen.push('two'); throw new Error('two') },
      () => { seen.push('three'); throw new Error('three') },
    ])).rejects.toBeInstanceOf(AggregateError)
    expect(seen).toEqual(['one', 'two', 'three'])
    await expect(failureAfterCleanup(new Error('operation'), [() => { throw new Error('cleanup') }])).resolves.toMatchObject({ message: 'environment runtime: operation and cleanup failed' })
    await expect(failureAfterCleanup('ok', [])).resolves.toBe('ok')
    await flush()
  })
})
