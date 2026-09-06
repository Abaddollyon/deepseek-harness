// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, DshWindow,
  WebBootEntry,
} from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry } from '../src/boot.ts'
import * as environmentRuntimePlugin from '@deepseek-ai/dsh-client-environment-runtime/client'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const PROVIDER_CLIENT_ID = 'provider/client'
const RUNTIME_CLIENT_ID = 'runtime/client'
const win = globalThis as DshWindow
const transportGlobal = globalThis as {
  __DSH_TRANSPORT__?: { loadBundle(url: string): Promise<void> }
}
const moduleFace = modulesClient as unknown as Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  delete transportGlobal.__DSH_TRANSPORT__
  document.body.innerHTML = ''
})

/** Install the stable facade shape that the Host injects before AppWebEntry runs. */
function installFacade(
  create?: (options: ClientModuleCreateOptions) => modulesClient.ClientModuleSystem,
): ClientModuleLoaderTarget {
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: create ?? (options => modulesClient.createClientModuleSystem(target, {
      id: MODULES_ID,
      exports: moduleFace,
    }, options)),
  }
  win.__ModuleLoader__ = target
  return target
}

async function expectBootFailure(setup: () => void, message: string): Promise<void> {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = document.createElement('div')
  document.body.append(container)
  setup()
  const entry = new AppWebEntry(container)
  await entry.run()
  expect(container.textContent).toContain(message)
  expect(error).toHaveBeenCalledOnce()
  await entry.dispose()
}

describe('bootstrap failure rendering', () => {
  it('renders a missing bootstrap facade', async () => {
    await expectBootFailure(
      () => { delete win.__ModuleLoader__ },
      'window.__ModuleLoader__ bootstrap facade is missing',
    )
  })

  it('renders a create failure owned by the facade', async () => {
    await expectBootFailure(() => {
      installFacade(() => { throw new Error('facade create failed') })
    }, 'facade create failed')
  })

  it('renders a malformed boot manifest', async () => {
    await expectBootFailure(() => {
      installFacade()
      delete win.__DSH_BOOT__
    }, 'window.__DSH_BOOT__ is missing or not an object')
  })

  it('renders a module-system construction failure', async () => {
    await expectBootFailure(() => {
      installFacade()
      const duplicate = { id: 'duplicate', url: '/duplicate/client.js', rev: '1' }
      win.__DSH_BOOT__ = {
        rev: 'graph',
        entries: [duplicate, duplicate],
        batches: [{ phase: 'application', url: '/batch.js', rev: 'batch', entries: ['duplicate'] }],
      }
    }, 'duplicate graph entry "duplicate"')
  })
})

describe('plugin activation', () => {
  it('exposes a reusable activator for independent runtime roots', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'capture', url: '/capture.js', rev: '1' },
      { id: 'domain', url: '/domain.js', rev: '1' },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = {
      rev: 'graph',
      entries,
      batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: entries.map(row => row.id) }],
    }
    let activator: { activate(ctx: Context, ids: readonly string[]): Promise<void> } | undefined
    const domainContexts: Context[] = []
    const registrations: ClientBundleRegistration[] = [
      { id: 'capture', factory: () => ({
        apply: (ctx: Context) => {
          activator = ctx.get('clientRuntimeActivator') as typeof activator
        },
      }) },
      { id: 'domain', factory: () => ({ apply: (ctx: Context) => { domainContexts.push(ctx) } }) },
      { id: 'renderer', factory: () => ({ apply: (ctx: Context) => {
        ctx.reflect.provide('uiRenderer', { mount: () => () => {} })
      } }) },
    ]
    const entry = new AppWebEntry(container, {
      loadBundle: async () => { for (const registration of registrations) target.load(registration) },
    })
    await entry.run()
    if (activator === undefined) throw new Error('clientRuntimeActivator was not provided')
    const runtime = new Context()

    await activator.activate(runtime, ['domain'])

    expect(domainContexts).toHaveLength(2)
    expect(domainContexts[0]).not.toBe(domainContexts[1])
    await runtime.fiber.dispose()
    await entry.dispose()
  })

  it('derives a trusted dependency closure and swaps the local presentation without duplicating it', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'capture', url: '/capture.js', rev: '1' },
      { id: 'shell', url: '/shell.js', rev: '1' },
      { id: 'domain', url: '/domain.js', rev: '1', inject: ['shell'] },
      { id: 'presentation', url: '/presentation.js', rev: '1', inject: ['domain'] },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = {
      rev: 'graph', entries,
      batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: entries.map(row => row.id) }],
    }
    type Activation = { dispose(): Promise<void> }
    type Withdrawal = { resume(): Promise<void> }
    interface Activator {
      available(): readonly string[]
      deriveRoster(roots: readonly string[], provided?: readonly string[]): readonly string[]
      serviceRequirements(ids: readonly string[]): Promise<readonly string[]>
      activate(ctx: Context, ids: readonly string[]): Promise<Activation>
      withdraw(ctx: Context, ids: readonly string[]): Promise<Withdrawal>
    }
    let activator: Activator | undefined
    let rootContext: Context | undefined
    let activePresentations = 0
    let activeRenderers = 0
    const registrations: ClientBundleRegistration[] = [
      { id: 'capture', factory: () => ({ apply: (ctx: Context) => {
        activator = ctx.get('clientRuntimeActivator')
        rootContext = ctx
      } }) },
      { id: 'shell', factory: () => ({ apply: () => {} }) },
      { id: 'domain', factory: () => ({ apply: (ctx: Context) => {
        ctx.reflect.provide('sessions', {})
        ctx.reflect.provide('remote.settings', {})
      } }) },
      { id: 'presentation', factory: () => ({ inject: ['sessions', 'remote.settings'], apply: (ctx: Context) => {
        activePresentations += 1
        ctx.effect(() => () => { activePresentations -= 1 })
      } }) },
      { id: 'renderer', factory: () => ({ apply: (ctx: Context) => {
        activeRenderers += 1
        ctx.effect(() => () => { activeRenderers -= 1 })
        ctx.reflect.provide('uiRenderer', { mount: () => () => {} })
      } }) },
    ]
    const app = new AppWebEntry(container, {
      loadBundle: async () => { for (const registration of registrations) target.load(registration) },
    })
    await app.run()
    if (activator === undefined || rootContext === undefined) throw new Error('runtime activator capture failed')

    const roster = activator.deriveRoster(['presentation'], ['shell'])
    expect(roster).toEqual(['domain', 'presentation'])
    expect(activator.available()).toEqual(entries.map(row => row.id))
    await expect(activator.serviceRequirements(['presentation']))
      .resolves.toEqual(['sessions', 'remote.settings'])
    const localPresentation = await activator.withdraw(rootContext, ['presentation'])
    expect(activePresentations).toBe(0)
    expect(activeRenderers).toBe(1)

    const remote = new Context()
    const remotePresentation = await activator.activate(remote, roster)
    expect(activePresentations).toBe(1)
    expect(activeRenderers).toBe(1)
    await remotePresentation.dispose()
    await localPresentation.resume()
    expect(activePresentations).toBe(1)
    expect(activeRenderers).toBe(1)

    await remote.fiber.dispose()
    await app.dispose()
    expect(activePresentations).toBe(0)
    expect(activeRenderers).toBe(0)
  })

  it('derives the reachable roster through a trusted manifest dependency cycle', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'capture', url: '/capture.js', rev: '1' },
      {
        id: 'workspace', url: '/workspace.js', rev: '1',
        inject: ['sidebar', '@deepseek-ai/dsh-client-ui-primitives'],
      },
      { id: 'sidebar', url: '/sidebar.js', rev: '1', inject: ['workspace'] },
    ]
    let activator: {
      deriveRoster(roots: readonly string[], provided?: readonly string[]): readonly string[]
    } | undefined
    const registrations: ClientBundleRegistration[] = [
      { id: 'capture', factory: () => ({ apply: (ctx: Context) => {
        activator = ctx.get('clientRuntimeActivator')
      } }) },
      { id: 'workspace', factory: () => ({ apply: () => {} }) },
      { id: 'sidebar', factory: () => ({ apply: () => {} }) },
    ]
    const app = new AppWebEntry(container, {
      loadBundle: async () => { for (const registration of registrations) target.load(registration) },
    })
    win.__DSH_BOOT__ = {
      rev: 'graph', entries,
      batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: entries.map(row => row.id) }],
    }
    await app.run()
    if (activator === undefined) throw new Error('runtime activator capture failed')

    expect(activator.deriveRoster(['workspace'])).toEqual(['workspace', 'sidebar'])
    await app.dispose()
  })

  it('keeps environment navigation and its coordinator active while its UI registrations are withdrawn', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const environmentRuntimeId = '@deepseek-ai/dsh-client-environment-runtime'
    const navigationUiId = '@deepseek-ai/dsh-client-ui-environment-navigation'
    const adapterId = '@arro/dsh-remote-ssh-ui'
    const entries: WebBootEntry[] = [
      { id: 'connection', url: '/connection.js', rev: '1' },
      { id: environmentRuntimeId, url: '/environment-runtime.js', rev: '1', inject: ['connection'] },
      { id: navigationUiId, url: '/navigation-ui.js', rev: '1', inject: [environmentRuntimeId] },
      { id: adapterId, url: '/adapter.js', rev: '1', inject: [environmentRuntimeId] },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = {
      rev: 'graph', entries,
      batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: entries.map(row => row.id) }],
    }
    interface Activator {
      withdraw(ctx: Context, ids: readonly string[]): Promise<{ resume(): Promise<void> }>
    }
    let activator: Activator | undefined
    let root: Context | undefined
    let navigationUi = 0
    let adapters = 0
    let navigationIdentity: unknown
    const registrations: ClientBundleRegistration[] = [
      { id: 'connection', factory: () => ({ apply: (ctx: Context) => {
        ctx.reflect.provide('connection', {
          generation: { getSnapshot: () => ({ id: 1 }), subscribe: () => () => {} },
        })
        ctx.reflect.provide('connectionFactory', { create: () => ({}) })
      } }) },
      { id: environmentRuntimeId, factory: () => environmentRuntimePlugin },
      { id: navigationUiId, factory: () => ({ inject: ['environmentNavigation'], apply: (ctx: Context) => {
        navigationUi += 1
        ctx.effect(() => () => { navigationUi -= 1 })
      } }) },
      { id: adapterId, factory: () => ({ inject: ['environmentNavigation'], apply: (ctx: Context) => {
        adapters += 1
        activator = ctx.get('clientRuntimeActivator')
        root = ctx
        navigationIdentity = ctx.get('environmentNavigation')
        ctx.effect(() => () => { adapters -= 1 })
      } }) },
      { id: 'renderer', factory: () => ({ apply: (ctx: Context) => {
        ctx.reflect.provide('uiRenderer', { mount: () => () => {} })
      } }) },
    ]
    const app = new AppWebEntry(container, {
      loadBundle: async () => { for (const registration of registrations) target.load(registration) },
    })
    await app.run()
    if (activator === undefined || root === undefined) throw new Error('runtime activator capture failed')

    const withdrawal = await activator.withdraw(root, [navigationUiId])

    expect(navigationUi).toBe(0)
    expect(adapters).toBe(1)
    expect(root.get('environmentNavigation')).toBe(navigationIdentity)
    await withdrawal.resume()
    expect(navigationUi).toBe(1)
    expect(adapters).toBe(1)

    await app.dispose()
    expect(navigationUi).toBe(0)
    expect(adapters).toBe(0)
  })

  it('restores already removed entries when a withdrawal cleanup fails', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'capture', url: '/capture.js', rev: '1' },
      { id: 'fragile-a', url: '/fragile-a.js', rev: '1' },
      { id: 'fragile-b', url: '/fragile-b.js', rev: '1' },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = {
      rev: 'graph', entries,
      batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: entries.map(row => row.id) }],
    }
    let activator: { withdraw(ctx: Context, ids: readonly string[]): Promise<unknown> } | undefined
    let root: Context | undefined
    const active = new Set<string>()
    const registrations: ClientBundleRegistration[] = [
      { id: 'capture', factory: () => ({ apply: (ctx: Context) => {
        activator = ctx.get('clientRuntimeActivator')
        root = ctx
      } }) },
      { id: 'fragile-a', factory: () => ({ apply: (ctx: Context) => {
        active.add('fragile-a')
        ctx.effect(() => () => { active.delete('fragile-a') })
      } }) },
      { id: 'fragile-b', factory: () => ({ apply: (ctx: Context) => {
        active.add('fragile-b')
        ctx.effect(() => () => {
          active.delete('fragile-b')
        })
      } }) },
      { id: 'renderer', factory: () => ({ apply: (ctx: Context) => {
        ctx.reflect.provide('uiRenderer', { mount: () => () => {} })
      } }) },
    ]
    const app = new AppWebEntry(container, {
      loadBundle: async () => { for (const registration of registrations) target.load(registration) },
    })
    await app.run()
    if (activator === undefined || root === undefined) throw new Error('runtime activator capture failed')
    const loader = root.get('loader') as { remove(id: string): Promise<void> }
    const remove = loader.remove.bind(loader)
    let removals = 0
    vi.spyOn(loader, 'remove').mockImplementation(async (id) => {
      removals += 1
      if (removals === 2) throw new Error('fixture cleanup failed')
      await remove(id)
    })

    await expect(activator.withdraw(root, ['fragile-a', 'fragile-b'])).rejects.toThrow('fixture cleanup failed')
    expect(active).toEqual(new Set(['fragile-a', 'fragile-b']))
    await app.dispose()
  })

  it('prefetches a parser-loaded immediate row through the injected bundle transport', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'consumer', url: '/consumer.js', rev: '1' },
      {
        id: 'runtime',
        url: '/runtime.js',
        rev: '1',
        external: [PROVIDER_CLIENT_ID],
        immediately: true,
      },
      { id: 'provider', url: '/provider.js', rev: '1' },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    const applicationUrl = '/application.js'
    win.__DSH_BOOT__ = {
      rev: 'graph',
      entries,
      batches: [{ phase: 'application', url: applicationUrl, rev: 'batch', entries: entries.map(row => row.id) }],
    }
    const loaded: string[] = []
    const registrations: ClientBundleRegistration[] = [
      {
        id: 'consumer',
        factory: require => ({
          apply: () => {
            expect((require(RUNTIME_CLIENT_ID) as { marker: string }).marker).toBe('provider')
          },
        }),
      },
      {
        id: 'provider',
        factory: () => ({ apply: () => {}, marker: 'provider' }),
      },
      {
        id: 'runtime',
        factory: require => ({
          apply: () => {},
          marker: (require(PROVIDER_CLIENT_ID) as { marker: string }).marker,
        }),
      },
      {
        id: 'renderer',
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', { mount: () => () => {} })
          },
        }),
      },
    ]
    transportGlobal.__DSH_TRANSPORT__ = {
      loadBundle: async (url) => {
        loaded.push(url)
        if (url !== applicationUrl) throw new Error(`missing fixture batch ${url}`)
        for (const registration of registrations) target.load(registration)
      },
    }

    const entry = new AppWebEntry(container)
    await entry.run()

    expect(loaded).toEqual([applicationUrl])
    await entry.dispose()
  })

  it('allows a modules-dependent row to be created before the modules row', async () => {
    const events: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'consumer', url: '/consumer.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = {
      rev: 'graph',
      entries,
      batches: [{
        phase: 'application',
        url: '/application.js',
        rev: 'batch',
        entries: entries.map(row => row.id),
      }],
    }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/consumer.js', {
        id: 'consumer',
        factory: () => ({
          inject: ['modules'],
          apply: (ctx: Context) => {
            expect(ctx.modules).toBeDefined()
            events.push('consumer')
          },
        }),
      }],
      ['/renderer.js', {
        id: 'renderer',
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                events.push('mount')
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        if (url !== '/application.js') throw new Error(`missing fixture batch ${url}`)
        for (const registration of registrations.values()) target.load(registration)
      },
    })

    await entry.run()

    expect(target.mode).toBe('live')
    expect(events).toEqual(['consumer', 'mount'])
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })
})
