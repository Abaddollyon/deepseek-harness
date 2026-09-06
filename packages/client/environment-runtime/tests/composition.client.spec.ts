import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import { createConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import { createEnvironmentCompositionService, type EnvironmentAppLocation } from '../src/client/composition.ts'

function navigation(initial: EnvironmentAppLocation) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    open(next: EnvironmentAppLocation) { current = next; for (const listener of [...listeners]) listener() },
  }
}

function sessions() {
  let current: string | undefined
  const listeners = new Set<() => void>()
  const byId = { same: { sessionId: 'same' } }
  return {
    open: vi.fn((sessionId: string) => { current = sessionId; for (const listener of [...listeners]) listener() }),
    list: {
      getSnapshot: () => ({ current, byId, phase: 'ready' as const }),
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
  }
}

function delayedSessions() {
  let current: string | undefined
  let byId: Record<string, { sessionId: string }> = {}
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of [...listeners]) listener() }
  const open = vi.fn((sessionId: string) => {
    if (byId[sessionId] === undefined) throw new Error(`sessions.select: unknown session ${sessionId}`)
    current = sessionId
    publish()
  })
  return {
    open,
    refresh: vi.fn(async () => {}),
    list: {
      getSnapshot: () => ({ current, byId, phase: Object.keys(byId).length === 0 ? 'pending' : 'ready' }),
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    hydrate(sessionId: string) {
      byId = { ...byId, [sessionId]: { sessionId } }
      publish()
    },
  }
}

describe('environment composition service', () => {
  test('does not project a withdrawn shell UI service into the remote presentation graph', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    shell.reflect.provide('uiSession', { owner: 'local' })
    const nav = navigation({ kind: 'environments', selectedId: 'sigil' })
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => ['uiSession'],
      async withdraw() { return { resume: async () => {} } },
      async activate(ctx: Context, ids: readonly string[]) {
        if (ids.includes('presentation')) {
          if (ctx.get('uiSession') !== undefined) throw new Error('stale local uiSession was projected')
          ctx.reflect.provide('uiSession', { owner: 'remote' })
        }
        return { dispose: async () => {} }
      },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: [],
      shellServices: [],
    })

    nav.open({ kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'chat' })
    await composition.whenIdle()
    expect(composition.getSnapshot()).toMatchObject({ phase: 'ready', environmentId: 'sigil' })
    await composition.dispose()
    await shell.fiber.dispose()
  })

  test('waits for a remote Session list to hydrate before opening its navigation target', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const nav = navigation({ kind: 'environments', selectedId: 'sigil' })
    const remoteSessions = delayedSessions()
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => [],
      async withdraw() { return { resume: async () => {} } },
      async activate(ctx: Context, ids: readonly string[]) {
        if (ids.includes('domain')) ctx.reflect.provide('sessions', remoteSessions)
        return { dispose: async () => {} }
      },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: ['sessions'],
      shellServices: [],
    })

    nav.open({ kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same-session' }, viewId: 'chat' })
    await composition.whenIdle()
    expect(composition.getSnapshot()).toMatchObject({ phase: 'ready', environmentId: 'sigil' })
    expect(remoteSessions.open).not.toHaveBeenCalled()

    remoteSessions.hydrate('same-session')
    expect(remoteSessions.open).toHaveBeenCalledWith('same-session')
    await composition.dispose()
    await shell.fiber.dispose()
  })

  test('retries Session hydration after a resolved failed refresh', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const nav = navigation({ kind: 'environments', selectedId: 'sigil' })
    const remoteSessions = delayedSessions()
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => [],
      async withdraw() { return { resume: async () => {} } },
      async activate(ctx: Context, ids: readonly string[]) {
        if (ids.includes('domain')) ctx.reflect.provide('sessions', remoteSessions)
        return { dispose: async () => {} }
      },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: ['sessions'],
      shellServices: [],
    })

    nav.open({ kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same-session' }, viewId: 'chat' })
    await composition.whenIdle()
    await vi.waitFor(() => { expect(remoteSessions.refresh).toHaveBeenCalledOnce() })
    await Promise.resolve()
    nav.open({ kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same-session' }, viewId: 'chat' })
    await vi.waitFor(() => { expect(remoteSessions.refresh).toHaveBeenCalledTimes(2) })
    remoteSessions.hydrate('same-session')
    expect(remoteSessions.open).toHaveBeenCalledWith('same-session')
    await composition.dispose()
    await shell.fiber.dispose()
  })

  test('commits root sources and session scope together across an async Host handoff', async () => {
    const shell = new Context()
    await shell.plugin(SlotRegistry)
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const nav = navigation({ kind: 'session', ref: { environmentId: 'local', sessionId: 'same' }, viewId: 'chat' })
    const localSource = { getSnapshot: () => 'local', subscribe: () => () => undefined }
    const remoteSource = { getSnapshot: () => 'sigil', subscribe: () => () => undefined }
    const absent = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
    const scope = (id: string) => ({
      id,
      current: { getSnapshot: () => absent, subscribe: () => () => undefined },
      resolve: () => undefined,
    })
    const localScope = scope('local')
    const remoteScope = scope('sigil')
    const mountLocalSources = () => shell.plugin({
      name: 'local-standard-sources',
      inject: ['slots'],
      apply: (ctx: Context) => {
        ctx.slots.provideRoot({ hooks: { sessions: localSource } })
        ctx.slots.installScope('session', localScope)
      },
    })
    let localOwner = mountLocalSources()
    await localOwner.await()
    let host: SlotRendererHost | undefined
    shell.slots.install({ renderRoot: (value) => { host = value; return null } })
    shell.slots.register({ name: 'root' }, () => null)
    shell.slots.renderSlot('root', {})
    if (host === undefined) throw new Error('fixture renderer did not receive its host')
    const seenRoots: unknown[] = [host.root.getSnapshot().hooks.sessions]
    const seenScopes: unknown[] = [host.scope('session')]
    host.root.subscribe(() => { seenRoots.push(host?.root.getSnapshot().hooks.sessions) })
    host.scopeRevision.subscribe(() => { seenScopes.push(host?.scope('session')) })

    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => ['slots'],
      async withdraw() {
        await localOwner.dispose()
        return {
          resume: async () => {
            localOwner = mountLocalSources()
            await localOwner.await()
          },
        }
      },
      async activate(ctx: Context, ids: readonly string[]) {
        if (ids.includes('presentation')) {
          ctx.slots.provideRoot({ hooks: { sessions: remoteSource } })
          ctx.slots.installScope('session', remoteScope)
        }
        return { dispose: async () => {} }
      },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: [],
      shellServices: ['slots'],
    })

    nav.open({ kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'chat' })
    await composition.whenIdle()
    expect(seenRoots).toEqual([localSource, remoteSource])
    expect(seenScopes).toEqual([localScope, remoteScope])

    nav.open({ kind: 'environments', selectedId: 'sigil' })
    await composition.whenIdle()
    expect(seenRoots).toEqual([localSource, remoteSource, localSource])
    expect(seenScopes).toEqual([localScope, remoteScope, localScope])
    await composition.dispose()
    await shell.fiber.dispose()
  })

  test('reports live connection loss and retries without remounting the selected presentation', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const nav = navigation({ kind: 'environments', selectedId: 'local' })
    let connect: (() => void) | undefined
    let drop: (() => void) | undefined
    let attempts = 0
    let presentations = 0
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => [],
      async withdraw() { return { resume: async () => {} } },
      async activate(ctx: Context, ids: readonly string[]) {
        if (ids.includes('domain')) {
          const connection = ctx.get('connection') as ConnectionHandle
          ctx.effect(() => connection.registerGenerationSource(async (signal, ready) => {
            attempts += 1
            if (attempts > 1) throw new Error('fixture carrier remains unavailable')
            await new Promise<void>((resolve) => {
              connect = () => { ready({ home: '/home/test' }) }
              drop = resolve
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }))
          const loop = connection.start({}, {
            backoffBaseMs: 1, backoffFactor: 1, backoffMaxMs: 1,
          })
          ctx.effect(() => () => { loop.stop() })
        }
        if (ids.includes('presentation')) presentations += 1
        return { dispose: async () => { if (ids.includes('presentation')) presentations -= 1 } }
      },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: [],
      shellServices: [],
    })
    nav.open({ kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'chat' })
    await composition.whenIdle()
    await vi.waitFor(() => { expect(connect).toBeTypeOf('function') })
    const mounted = composition.getSnapshot()
    expect(mounted).toMatchObject({ phase: 'ready', connectionState: 'connecting' })

    connect?.()
    await vi.waitFor(() => {
      expect(composition.getSnapshot()).toMatchObject({ phase: 'ready', connectionState: 'connected' })
    })
    const connected = composition.getSnapshot()
    expect(connected.phase === 'ready' ? connected.lastConnectedAt : undefined).toBeTypeOf('number')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    drop?.()
    await vi.waitFor(() => {
      expect(composition.getSnapshot()).toMatchObject({ phase: 'ready', connectionState: 'disconnected' })
    })
    expect(presentations).toBe(1)
    const disconnected = composition.getSnapshot()
    expect(disconnected.phase === 'ready'
      && connected.phase === 'ready'
      && disconnected.runtime === connected.runtime).toBe(true)
    const selected = nav.getSnapshot()

    composition.retry()
    expect(nav.getSnapshot()).toEqual(selected)
    expect(composition.getSnapshot()).toMatchObject({ phase: 'ready', connectionState: 'connecting' })
    expect(presentations).toBe(1)
    warn.mockRestore()
    await composition.dispose()
    await shell.fiber.dispose()
  })

  test('withdraws local presentation, opens a Session on its owning runtime, and restores local navigation', async () => {
    const shell = new Context()
    const localSessions = sessions()
    shell.reflect.provide('sessions', localSessions)
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const nav = navigation({ kind: 'environments', selectedId: 'local' })
    const remoteSessions = new Map<string, ReturnType<typeof sessions>>()
    let localWithdrawn = 0
    let remotePresentation = 0
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => [],
      async withdraw() {
        localWithdrawn += 1
        return { resume: async () => { localWithdrawn -= 1 } }
      },
      async activate(ctx: Context, ids: readonly string[]) {
        if (ids.includes('domain')) {
          const value = sessions()
          remoteSessions.set(ctx.environmentRuntime.environmentId, value)
          ctx.reflect.provide('sessions', value)
        }
        if (ids.includes('presentation')) remotePresentation += 1
        return { dispose: async () => { if (ids.includes('presentation')) remotePresentation -= 1 } }
      },
    }
    const carrierDispose = vi.fn()
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: carrierDispose,
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: ['sessions'],
      shellServices: [],
    })

    nav.open({ kind: 'environments', selectedId: 'sigil' })
    await composition.whenIdle()
    expect(localWithdrawn).toBe(0)
    expect(remotePresentation).toBe(0)
    expect(carrierDispose).not.toHaveBeenCalled()

    nav.open({ kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'chat' })
    await composition.whenIdle()
    expect(localWithdrawn).toBe(1)
    expect(remotePresentation).toBe(1)
    expect(remoteSessions.get('sigil')?.open).toHaveBeenCalledWith('same')

    remoteSessions.get('sigil')?.open('child')
    expect(nav.getSnapshot()).toEqual({
      kind: 'session', ref: { environmentId: 'sigil', sessionId: 'child' }, viewId: 'chat',
    })

    nav.open({ kind: 'session', ref: { environmentId: 'local', sessionId: 'same' }, viewId: 'chat' })
    await composition.whenIdle()
    expect(localSessions.open).toHaveBeenCalledWith('same')
    expect(localWithdrawn).toBe(0)
    expect(remotePresentation).toBe(0)
    expect(carrierDispose).toHaveBeenCalledOnce()

    nav.open({ kind: 'environments', selectedId: 'local' })
    localSessions.open('local-child')
    expect(nav.getSnapshot()).toEqual({
      kind: 'session', ref: { environmentId: 'local', sessionId: 'local-child' }, viewId: 'chat',
    })
    await composition.dispose()
    await shell.fiber.dispose()
  })

  test('resolves an exact remote presentation only after its runtime and UI are connected', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const nav = navigation({ kind: 'session', ref: { environmentId: 'local', sessionId: 'same' }, viewId: 'chat' })
    let connect!: () => void
    let remoteEnvironmentRuntime!: {
      generation: { getSnapshot(): { environmentId: string; runtimeId: string; generation: number } | undefined }
    }
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => [],
      async withdraw() { return { resume: async () => {} } },
      async activate(ctx: Context, ids: readonly string[]) {
        if (ids.includes('domain')) {
          remoteEnvironmentRuntime = ctx.environmentRuntime
          const connection = ctx.get('connection') as ConnectionHandle
          ctx.effect(() => connection.registerGenerationSource(async (signal, ready) => {
            await new Promise<void>((resolve) => {
              connect = () => { ready({ home: '/remote' }) }
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }))
          const loop = connection.start({})
          ctx.effect(() => () => { loop.stop() })
        }
        if (ids.includes('presentation')) {
          ctx.reflect.provide('destinationService', { owner: ctx.environmentRuntime.environmentId })
        }
        return { dispose: async () => {} }
      },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: [],
      shellServices: [],
    })

    const callback = vi.fn((context: Context) => (context.get('destinationService') as { owner: string }).owner)
    const resolving = service.withPresentation(
      { kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'tasks' },
      callback,
    )
    await vi.waitFor(() => { expect(connect).toBeTypeOf('function') })
    expect(composition.getSnapshot()).toMatchObject({
      phase: 'ready', environmentId: 'sigil', connectionState: 'connecting',
    })
    expect(callback).not.toHaveBeenCalled()
    connect()
    const owner = await resolving

    expect(owner).toBe('sigil')
    expect(nav.getSnapshot()).toMatchObject({ kind: 'session', ref: { environmentId: 'sigil' } })
    await expect(service.withPresentation(
      { kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'tasks' },
      async () => {
        const generation = remoteEnvironmentRuntime.generation.getSnapshot()
        if (generation === undefined) throw new Error('fixture generation missing')
        Object.defineProperty(remoteEnvironmentRuntime.generation, 'getSnapshot', {
          value: () => ({ ...generation, generation: generation.generation + 1 }),
        })
      },
    )).rejects.toThrow('generation changed during callback')
    await composition.dispose()
    await shell.fiber.dispose()
  })

  test('resolves a local presentation through the shell before composition starts', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('destinationService', { owner: 'local' })
    const nav = navigation({ kind: 'environments', selectedId: 'local' })
    shell.reflect.provide('environmentNavigation', nav)
    const service = createEnvironmentCompositionService(shell)

    await expect(service.withPresentation(
      { kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'tasks' },
      () => undefined,
    )).rejects.toThrow('remote presentation requires a running composition')

    const owner = await service.withPresentation(
      { kind: 'session', ref: { environmentId: 'local', sessionId: 'same' }, viewId: 'tasks' },
      context => (context.get('destinationService') as { owner: string }).owner,
    )

    expect(owner).toBe('local')
    expect(nav.getSnapshot()).toMatchObject({ kind: 'session', ref: { environmentId: 'local' } })
    await shell.fiber.dispose()
  })

  test('cancels local presentation work through the caller signal', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    const nav = navigation({ kind: 'environments', selectedId: 'local' })
    shell.reflect.provide('environmentNavigation', nav)
    const service = createEnvironmentCompositionService(shell)
    const abort = new AbortController()
    let callbackSignal: AbortSignal | undefined
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })

    const resolving = service.withPresentation(
      { kind: 'session', ref: { environmentId: 'local', sessionId: 'same' }, viewId: 'tasks' },
      async (_context, signal) => {
        callbackSignal = signal
        await held
      },
      { signal: abort.signal },
    )
    abort.abort(new DOMException('deadline elapsed', 'TimeoutError'))

    await expect(resolving).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(callbackSignal?.aborted).toBe(true)
    release()
    await shell.fiber.dispose()
  })

  test('rejects a presentation callback when a newer navigation intent supersedes it', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const nav = navigation({ kind: 'session', ref: { environmentId: 'local', sessionId: 'same' }, viewId: 'chat' })
    let entered!: () => void
    const presentationEntered = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const holdPresentation = new Promise<void>((resolve) => { release = resolve })
    const callback = vi.fn()
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => [],
      async withdraw() { return { resume: async () => {} } },
      async activate(_ctx: Context, ids: readonly string[]) {
        if (ids.includes('presentation')) {
          entered()
          await holdPresentation
        }
        return { dispose: async () => {} }
      },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: [],
      shellServices: [],
    })

    const resolving = service.withPresentation(
      { kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'tasks' },
      callback,
    )
    await presentationEntered
    nav.open({ kind: 'session', ref: { environmentId: 'local', sessionId: 'other' }, viewId: 'chat' })
    release()

    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' })
    expect(callback).not.toHaveBeenCalled()
    await composition.dispose()
    await shell.fiber.dispose()
  })

  test('keeps an unready remote presentation cancellable while its generation is unavailable', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const nav = navigation({ kind: 'environments', selectedId: 'local' })
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => [],
      async withdraw() { return { resume: async () => {} } },
      async activate() { return { dispose: async () => {} } },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: [],
      shellServices: [],
    })
    const callback = vi.fn()

    await expect(service.withPresentation(
      { kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'tasks' },
      callback,
      { signal: AbortSignal.timeout(25) },
    )).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(callback).not.toHaveBeenCalled()
    await composition.dispose()
    await shell.fiber.dispose()
  })

  test('cancels presentation resolution when the running composition is disposed', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    const nav = navigation({ kind: 'environments', selectedId: 'local' })
    let entered!: () => void
    const presentationEntered = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      serviceRequirements: async () => [],
      async withdraw() { return { resume: async () => {} } },
      async activate(_ctx: Context, ids: readonly string[]) {
        if (ids.includes('presentation')) {
          entered()
          await held
        }
        return { dispose: async () => {} }
      },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const composition = await service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: [],
      shellServices: [],
    })
    const callback = vi.fn()
    const resolving = service.withPresentation(
      { kind: 'session', ref: { environmentId: 'sigil', sessionId: 'same' }, viewId: 'tasks' },
      callback,
    )
    await presentationEntered

    const disposing = composition.dispose()
    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' })
    release()
    await disposing
    expect(callback).not.toHaveBeenCalled()
    await shell.fiber.dispose()
  })

  test('waits for an in-progress composition start before resolving local presentation', async () => {
    const shell = new Context()
    shell.reflect.provide('environmentRuntime', { environmentId: 'local' })
    shell.reflect.provide('connectionFactory', { create: createConnectionHandle })
    shell.reflect.provide('destinationService', { owner: 'local' })
    const nav = navigation({ kind: 'environments', selectedId: 'local' })
    shell.reflect.provide('environmentNavigation', nav)
    let releaseRequirements!: () => void
    const requirementsHeld = new Promise<void>((resolve) => { releaseRequirements = resolve })
    const callback = vi.fn((context: Context) => (context.get('destinationService') as { owner: string }).owner)
    const activator = {
      deriveRoster: (roots: readonly string[]) => [...roots],
      async serviceRequirements() { await requirementsHeld; return [] },
      async withdraw() { return { resume: async () => {} } },
      async activate() { return { dispose: async () => {} } },
    }
    const service = createEnvironmentCompositionService(shell)
    service.registerFactory(async () => ({
      request: async () => new Response('ok'),
      connectionTransport: { fetch: vi.fn() },
      dispose: () => {},
    }))
    const starting = service.start({
      navigation: nav,
      activator,
      domain: { roots: ['domain'] },
      presentation: { roots: ['presentation'] },
      runtimeServices: [],
      shellServices: [],
    })
    const resolving = service.withPresentation(
      { kind: 'session', ref: { environmentId: 'local', sessionId: 'same' }, viewId: 'tasks' },
      callback,
    )
    expect(callback).not.toHaveBeenCalled()
    releaseRequirements()

    const composition = await starting
    await expect(resolving).resolves.toBe('local')
    expect(callback).toHaveBeenCalledOnce()
    await composition.dispose()
    await shell.fiber.dispose()
  })
})
