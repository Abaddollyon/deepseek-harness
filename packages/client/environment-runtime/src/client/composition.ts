import type { Context } from '@deepseek-ai/cordis'
import type { ClientTransportHooks, ConnectionFactory } from '@deepseek-ai/dsh-client-connection/client'
import { createActiveEnvironmentRuntimeProjection } from './active-projection.ts'
import type { ActiveEnvironmentRuntimeState } from './active-projection.ts'
import { createEnvironmentPresentationMount } from './presentation-mount.ts'
import { createEnvironmentRuntimeRegistry, type EnvironmentRuntime } from './registry.ts'
import { createEnvironmentRuntime } from './runtime.ts'
import type { EnvironmentId } from './identity.ts'
import type { AppLocation, EnvironmentNavigation } from './navigation.ts'
import { failureAfterCleanup, runCleanupSteps } from './cleanup.ts'

/** Carrier lease supplied by a trusted Host catalog/controller. */
export interface EnvironmentClientCarrier {
  /** Runtime-bound feature request carrier. */
  request(path: string, init?: RequestInit): Promise<Response>
  /** Runtime-bound Connection unary and stream transport. */
  readonly connectionTransport: ClientTransportHooks
  /** Release the server-side/client-side Host lease. */
  dispose(): void | Promise<void>
}

/** Trusted factory resolves a saved Environment identity to a carrier lease. */
export type EnvironmentClientCarrierFactory = (
  environmentId: EnvironmentId,
) => Promise<EnvironmentClientCarrier>

/** Manifest roster root set and package faces already supplied by another context. */
export interface EnvironmentRosterSpec {
  readonly roots: readonly string[]
  readonly provided?: readonly string[]
}

/** Structural client graph activator supplied by the Web boot kernel. */
export interface EnvironmentClientRuntimeActivator {
  available?(): readonly string[]
  deriveRoster(roots: readonly string[], provided?: readonly string[]): readonly string[]
  serviceRequirements?(ids: readonly string[]): Promise<readonly string[]>
  activate(context: Context, ids: readonly string[]): Promise<{ dispose(): Promise<void> }>
  withdraw(context: Context, ids: readonly string[]): Promise<{ resume(): Promise<void> }>
}

/** Persistent-shell location contract consumed without a package cycle. */
export type EnvironmentAppLocation = AppLocation

/** Persistent-shell navigation contract consumed without a package cycle. */
export type EnvironmentCompositionNavigation = Pick<EnvironmentNavigation, 'open' | 'getSnapshot' | 'subscribe'>

/** Runtime and presentation graph inputs for selected-Host composition. */
export interface EnvironmentCompositionOptions {
  readonly navigation: EnvironmentCompositionNavigation
  readonly activator: EnvironmentClientRuntimeActivator
  readonly domain: EnvironmentRosterSpec
  readonly presentation: EnvironmentRosterSpec
  /** Local Host UI entries withdrawn while a remote Host owns presentation. */
  readonly suspension?: EnvironmentRosterSpec
  /** Owning-runtime service faces made visible to selected UI plugins. */
  readonly runtimeServices: readonly string[]
  /** Persistent renderer/layout service faces made visible to selected UI plugins. */
  readonly shellServices: readonly string[]
  readonly localEnvironmentId?: EnvironmentId
  readonly defaultViewId?: string
}

/** Active environment composition lifecycle. */
export interface EnvironmentComposition {
  /** Selected-runtime readiness/error state for visible shell feedback. */
  getSnapshot(): ActiveEnvironmentRuntimeState
  /** Subscribe to selected-runtime readiness/error state. */
  subscribe(listener: () => void): () => void
  /** Wait for the latest Host switch and UI activation. */
  whenIdle(): Promise<void>
  /** Retry the current failed Host selection. */
  retry(): void
  /** Dispose remote runtimes/presentation and restore local presentation. */
  dispose(): Promise<void>
}

/** Shell-owned coordinator configured by the product's trusted Host adapter. */
export interface EnvironmentCompositionService {
  /** Install the sole trusted carrier factory for this shell lifetime. */
  registerFactory(factory: EnvironmentClientCarrierFactory): () => void
  /** Start navigation-driven runtime/presentation composition. */
  start(options: EnvironmentCompositionOptions): Promise<EnvironmentComposition>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Selected-Host runtime and single-shell composition owner. */
    environmentComposition: EnvironmentCompositionService
  }
}

/**
 * Create the shell-owned environment composition service.
 * @param shell - persistent shell context whose renderer services presentations share.
 * @returns the single-carrier composition service.
 */
export function createEnvironmentCompositionService(shell: Context): EnvironmentCompositionService {
  let factory: EnvironmentClientCarrierFactory | undefined
  let running = false
  return {
    registerFactory(next) {
      if (factory !== undefined) throw new Error('environment composition: a carrier factory is already registered')
      factory = next
      return () => { if (factory === next) factory = undefined }
    },
    async start(options) {
      if (running) throw new Error('environment composition: composition is already running')
      if (factory === undefined) throw new Error('environment composition: no carrier factory is registered')
      running = true
      try {
        return await startComposition(shell, factory, options, () => { running = false })
      } catch (error) {
        running = false
        throw error
      }
    },
  }
}

async function startComposition(
  shell: Context,
  factory: EnvironmentClientCarrierFactory,
  options: EnvironmentCompositionOptions,
  released: () => void,
): Promise<EnvironmentComposition> {
  const localEnvironmentId = options.localEnvironmentId ?? 'local'
  const defaultViewId = options.defaultViewId ?? 'chat'
  const connectionFactory = shell.get('connectionFactory' as string) as ConnectionFactory | undefined
  if (connectionFactory === undefined) {
    throw new Error('environment composition: Connection factory is unavailable')
  }
  const domainRoster = options.activator.deriveRoster(options.domain.roots, options.domain.provided)
  const presentationRoster = options.activator.deriveRoster(
    options.presentation.roots,
    options.presentation.provided,
  )
  const suspensionRoster = options.suspension === undefined
    ? presentationRoster
    : options.activator.deriveRoster(options.suspension.roots, options.suspension.provided)
  const presentationRequirements = await options.activator.serviceRequirements?.(presentationRoster) ?? []
  const registry = createEnvironmentRuntimeRegistry({
    createRuntime: async (environmentId) => {
      const carrier = await factory(environmentId)
      try {
        const runtime = await createEnvironmentRuntime({
          environmentId,
          request: (boundEnvironmentId, path, init) => {
            if (boundEnvironmentId !== environmentId) {
              throw new Error('environment composition: carrier identity mismatch')
            }
            return carrier.request(path, init)
          },
          connectionTransport: carrier.connectionTransport,
          createConnection: transport => connectionFactory.create(transport),
          activate: async (context) => { await options.activator.activate(context, domainRoster) },
        })
        return wrapRuntimeDisposal(runtime, carrier)
      } catch (error) {
        await carrier.dispose()
        throw error
      }
    },
  })
  const remoteSelection = {
    getSnapshot: (): EnvironmentId | undefined => {
      const environmentId = environmentOf(options.navigation.getSnapshot())
      return environmentId === undefined || environmentId === localEnvironmentId ? undefined : environmentId
    },
    subscribe: (listener: () => void) => options.navigation.subscribe(listener),
  }
  const projection = createActiveEnvironmentRuntimeProjection({
    registry,
    selection: remoteSelection,
    holdTransition: () => {
      const slots = shell.get('slots') as { holdStandardSourceTransitions?(): () => void } | undefined
      return slots?.holdStandardSourceTransitions?.() ?? (() => {})
    },
    activate: async (runtime, signal) => {
      const localWithdrawal = await options.activator.withdraw(shell, suspensionRoster)
      const projected = resolvePresentationServices(
        runtime.context,
        presentationRequirements,
        options.runtimeServices,
        options.shellServices,
      )
      let presentation
      try {
        presentation = await createEnvironmentPresentationMount({
          runtime,
          shell,
          signal,
          runtimeServices: projected.runtime,
          shellServices: projected.shell,
          activate: async (context) => {
            const activation = await options.activator.activate(context, presentationRoster)
            return () => activation.dispose()
          },
        })
      } catch (error) {
        throw await failureAfterCleanup(error, [localWithdrawal.resume])
      }
      const activeLocationOff = followSessionLocation(
        runtime.context, runtime.environmentId, options.navigation,
      )
      const activeSessionOff = publishSessionOpens(
        runtime.context, runtime.environmentId, options.navigation, defaultViewId,
      )
      return async () => {
        await runCleanupSteps([
          activeLocationOff,
          activeSessionOff,
          () => presentation.dispose(),
          localWithdrawal.resume,
        ])
      }
    },
  })
  const localLocationOff = followSessionLocation(shell, localEnvironmentId, options.navigation)
  const localSessionsOff = publishSessionOpens(shell, localEnvironmentId, options.navigation, defaultViewId)
  let disposed = false
  return {
    getSnapshot: () => projection.getSnapshot(),
    subscribe: listener => projection.subscribe(listener),
    whenIdle: () => projection.whenIdle(),
    retry: () => { projection.retry() },
    async dispose() {
      if (disposed) return
      disposed = true
      await runCleanupSteps([
        localLocationOff,
        localSessionsOff,
        () => projection.dispose(),
        () => registry.dispose(),
        released,
      ])
    },
  }
}

function resolvePresentationServices(
  runtime: Context,
  requirements: readonly string[],
  runtimeServices: readonly string[],
  shellServices: readonly string[],
): { runtime: readonly string[]; shell: readonly string[] } {
  const runtimeOwned = new Set(runtimeServices)
  const shellOwned = new Set(shellServices)
  for (const name of requirements) {
    if (runtimeOwned.has(name) || shellOwned.has(name)) continue
    // Reflect only owning-runtime child services (for example remote.*).
    // Presentation services such as uiSession/uiWorkspace are recreated in
    // this graph; projecting a withdrawing local instance would bind the
    // remote entries to stale local hook registries.
    if (runtime.get(name) !== undefined) runtimeOwned.add(name)
  }
  return { runtime: [...runtimeOwned], shell: [...shellOwned] }
}

function environmentOf(location: EnvironmentAppLocation): EnvironmentId | undefined {
  return location.kind === 'session' ? location.ref.environmentId : undefined
}

function followSessionLocation(
  context: Context,
  environmentId: EnvironmentId,
  navigation: EnvironmentCompositionNavigation,
): () => void {
  const sessions = context.get('sessions') as {
    list?: {
      getSnapshot(): { current?: string; byId?: Readonly<Record<string, unknown>> }
      subscribe(listener: () => void): () => void
    }
    open?(sessionId: string): void
    refresh?(): Promise<void>
  } | undefined
  if (sessions?.list === undefined || sessions.open === undefined) return () => {}
  let stopped = false
  let refreshTarget: string | undefined
  let locationTarget: string | undefined
  let locationHydrated = false
  const sync = (): void => {
    if (stopped) return
    const location = navigation.getSnapshot()
    if (location.kind !== 'session' || location.ref.environmentId !== environmentId) return
    const snapshot = sessions.list?.getSnapshot()
    if (snapshot === undefined) return
    const sessionId = location.ref.sessionId
    if (locationTarget !== sessionId) {
      locationTarget = sessionId
      locationHydrated = false
      refreshTarget = undefined
    }
    // Once the navigation target has been applied, later Session opens are
    // user/domain events and must be allowed to drive navigation forward.
    if (locationHydrated) return
    if (snapshot.byId?.[sessionId] !== undefined) {
      refreshTarget = undefined
      if (snapshot.current !== sessionId) {
        sessions.open?.(sessionId)
      } else {
        locationHydrated = true
      }
      return
    }
    if (sessions.refresh === undefined || refreshTarget === sessionId) return
    refreshTarget = sessionId
    void sessions.refresh().then(() => {
      if (refreshTarget === sessionId) refreshTarget = undefined
    }, () => {
      if (refreshTarget === sessionId) refreshTarget = undefined
    })
  }
  const offNavigation = navigation.subscribe(sync)
  const offSessions = sessions.list.subscribe(sync)
  sync()
  return () => {
    stopped = true
    offSessions()
    offNavigation()
  }
}

function publishSessionOpens(
  context: Context,
  environmentId: EnvironmentId,
  navigation: EnvironmentCompositionNavigation,
  defaultViewId: string,
): () => void {
  const sessions = context.get('sessions') as {
    list?: { getSnapshot(): { current?: string }; subscribe(listener: () => void): () => void }
  } | undefined
  if (sessions?.list === undefined) return () => {}
  let previous = sessions.list.getSnapshot().current
  return sessions.list.subscribe(() => {
    const current = sessions.list?.getSnapshot().current
    if (current === undefined || current === previous) return
    previous = current
    const location = navigation.getSnapshot()
    if (location.kind === 'session'
      && location.ref.environmentId === environmentId
      && location.ref.sessionId === current) return
    navigation.open({
      kind: 'session',
      ref: { environmentId, sessionId: current },
      viewId: defaultViewId,
    })
  })
}

function wrapRuntimeDisposal(
  runtime: EnvironmentRuntime,
  carrier: EnvironmentClientCarrier,
): EnvironmentRuntime {
  let disposed = false
  return {
    ...runtime,
    async dispose() {
      if (disposed) return
      disposed = true
      await runCleanupSteps([
        () => runtime.dispose(),
        () => carrier.dispose(),
      ])
    },
  }
}
