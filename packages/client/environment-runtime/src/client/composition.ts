import type { Context } from '@deepseek-ai/cordis'
import type { ClientTransportHooks, ConnectionFactory } from '@deepseek-ai/dsh-client-connection/client'
import { createActiveEnvironmentRuntimeProjection } from './active-projection.ts'
import type {
  ActiveEnvironmentRuntimeProjection,
  ActiveEnvironmentRuntimeState,
} from './active-projection.ts'
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

/** Cancellation controls for one exact presentation-bound operation. */
export interface EnvironmentPresentationResolutionOptions {
  /** Cancels navigation, readiness waiting, or acknowledgement; an entered callback must observe the same signal. */
  readonly signal?: AbortSignal
}

/** Operation performed while one destination presentation remains current. */
export type EnvironmentPresentationCallback<T> = (
  context: Context,
  signal: AbortSignal,
) => T | Promise<T>

/** Shell-owned coordinator configured by the product's trusted Host adapter. */
export interface EnvironmentCompositionService {
  /**
   * Install the sole trusted carrier factory for this shell lifetime.
   * @param factory - product-owned factory for environment client carriers.
   * @returns disposer that withdraws this factory while it remains current.
   */
  registerFactory(factory: EnvironmentClientCarrierFactory): () => void
  /**
   * Navigate to one location and run work against its fully activated presentation.
   * Remote destinations must have a connected generation. The callback receives
   * the remote presentation context or the restored local shell, and the result
   * is acknowledged only while the same navigation intent and generation remain current.
   * @param location - exact shell destination to open.
   * @param callback - short-lived operation using destination-owned services and the combined intent signal.
   * @param options - caller cancellation or deadline signal.
   * @returns the callback result after the final selection and generation fence.
   */
  withPresentation<T>(
    location: EnvironmentAppLocation,
    callback: EnvironmentPresentationCallback<T>,
    options?: EnvironmentPresentationResolutionOptions,
  ): Promise<T>
  /**
   * Start navigation-driven runtime/presentation composition.
   * @param options - trusted runtime roster and shell presentation services.
   * @returns the active environment composition lifecycle.
   */
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
  let active: RunningEnvironmentComposition | undefined
  let starting: Promise<RunningEnvironmentComposition> | undefined
  return {
    registerFactory(next) {
      if (factory !== undefined) throw new Error('environment composition: a carrier factory is already registered')
      factory = next
      return () => { if (factory === next) factory = undefined }
    },
    async withPresentation(location, callback, options) {
      if (active !== undefined) return active.withPresentation(location, callback, options)
      if (starting !== undefined) {
        const composition = await raceWithSignal(starting, options?.signal)
        return composition.withPresentation(location, callback, options)
      }
      const navigation = shell.get('environmentNavigation') as EnvironmentCompositionNavigation | undefined
      if (navigation === undefined) {
        throw new Error('environment composition: navigation is unavailable')
      }
      const localRuntime = localRuntimeOf(shell)
      const target = environmentOf(location) ?? localRuntime.environmentId
      if (target !== localRuntime.environmentId) {
        throw new Error('environment composition: remote presentation requires a running composition')
      }
      return withNavigationIntent(navigation, location, options?.signal, async (assertCurrent, signal) => {
        const generation = readyGenerationOf(localRuntime, 'destination Host is not connected')
        const result = await callback(shell, signal)
        assertCurrent()
        assertSameGeneration(localRuntime, generation)
        return result
      })
    },
    async start(options) {
      if (running) throw new Error('environment composition: composition is already running')
      if (factory === undefined) throw new Error('environment composition: no carrier factory is registered')
      running = true
      let composition!: RunningEnvironmentComposition
      const pending = startComposition(shell, factory, options, () => {
        running = false
        if (active === composition) active = undefined
      })
      starting = pending
      try {
        composition = await pending
        active = composition
        return composition
      } catch (error) {
        running = false
        throw error
      } finally {
        if (starting === pending) starting = undefined
      }
    },
  }
}

interface RunningEnvironmentComposition extends EnvironmentComposition {
  withPresentation<T>(
    location: EnvironmentAppLocation,
    callback: EnvironmentPresentationCallback<T>,
    options?: EnvironmentPresentationResolutionOptions,
  ): Promise<T>
}

interface ActivePresentation {
  readonly runtime: EnvironmentRuntime
  readonly context: Context
}

async function startComposition(
  shell: Context,
  factory: EnvironmentClientCarrierFactory,
  options: EnvironmentCompositionOptions,
  released: () => void,
): Promise<RunningEnvironmentComposition> {
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
  let activePresentation: ActivePresentation | undefined
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
        activePresentation = { runtime, context: presentation.context }
      } catch (error) {
        throw await failureAfterCleanup(error, [() => localWithdrawal.resume()])
      }
      const activeLocationOff = followSessionLocation(
        runtime.context, runtime.environmentId, options.navigation,
      )
      const activeSessionOff = publishSessionOpens(
        runtime.context, runtime.environmentId, options.navigation, defaultViewId,
      )
      return async () => {
        if (activePresentation?.context === presentation.context) activePresentation = undefined
        await runCleanupSteps([
          activeLocationOff,
          activeSessionOff,
          () => presentation.dispose(),
          () => localWithdrawal.resume(),
        ])
      }
    },
  })
  const localLocationOff = followSessionLocation(shell, localEnvironmentId, options.navigation)
  const localSessionsOff = publishSessionOpens(shell, localEnvironmentId, options.navigation, defaultViewId)
  let disposed = false
  const lifetime = new AbortController()
  return {
    getSnapshot: () => projection.getSnapshot(),
    subscribe: listener => projection.subscribe(listener),
    whenIdle: () => projection.whenIdle(),
    retry: () => { projection.retry() },
    withPresentation(location, callback, resolutionOptions) {
      if (disposed) return Promise.reject(new Error('environment composition: composition is disposed'))
      return withNavigationIntent(
        options.navigation,
        location,
        combineSignals(resolutionOptions?.signal, lifetime.signal),
        async (assertCurrent, signal) => {
          await projection.whenIdle()
          assertCurrent()
          const target = environmentOf(location) ?? localEnvironmentId
          if (target === localEnvironmentId) {
            const state = projection.getSnapshot()
            if (state.phase !== 'idle' || activePresentation !== undefined) {
              throw new Error('environment composition: local presentation is not restored')
            }
            const runtime = localRuntimeOf(shell, localEnvironmentId)
            const generation = readyGenerationOf(runtime, 'destination Host is not connected')
            const result = await callback(shell, signal)
            assertCurrent()
            assertSameGeneration(runtime, generation)
            return result
          }
          const destination = await waitForRemotePresentation(
            projection, () => activePresentation, target, signal,
          )
          const generation = readyGenerationOf(destination.runtime, 'destination Host is not connected')
          const result = await callback(destination.context, signal)
          assertCurrent()
          assertSameGeneration(destination.runtime, generation)
          requireRemotePresentation(projection.getSnapshot(), activePresentation, target, destination)
          return result
        },
      )
    },
    async dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort(abortError('Environment composition was disposed'))
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

interface RuntimeIdentity {
  readonly environmentId: EnvironmentId
  readonly runtimeId?: string
  readonly generation?: { getSnapshot(): { environmentId: EnvironmentId; runtimeId: string; generation: number } | undefined }
}

function localRuntimeOf(shell: Context, expected?: EnvironmentId): RuntimeIdentity {
  const runtime = shell.get('environmentRuntime') as RuntimeIdentity | undefined
  if (runtime === undefined || (expected !== undefined && runtime.environmentId !== expected)) {
    throw new Error('environment composition: local runtime is unavailable')
  }
  return runtime
}

function readyGenerationOf(
  runtime: RuntimeIdentity,
  unavailableMessage: string,
): { environmentId: EnvironmentId; runtimeId: string; generation: number } | undefined {
  if (runtime.generation === undefined) return undefined
  const generation = runtime.generation.getSnapshot()
  if (generation === undefined) throw new Error(`environment composition: ${unavailableMessage}`)
  return generation
}

function assertSameGeneration(
  runtime: RuntimeIdentity,
  expected: ReturnType<typeof readyGenerationOf>,
): void {
  if (expected === undefined) return
  const current = runtime.generation?.getSnapshot()
  if (current === undefined
    || current.environmentId !== expected.environmentId
    || current.runtimeId !== expected.runtimeId
    || current.generation !== expected.generation) {
    throw new Error('environment composition: destination Host generation changed during callback')
  }
}

function requireRemotePresentation(
  state: ActiveEnvironmentRuntimeState,
  presentation: ActivePresentation | undefined,
  environmentId: EnvironmentId,
  expected?: ActivePresentation,
): ActivePresentation {
  if (state.phase === 'error' && state.environmentId === environmentId) {
    throw new Error('environment composition: destination activation failed', { cause: state.error })
  }
  if (state.phase !== 'ready'
    || state.environmentId !== environmentId
    || state.connectionState !== 'connected'
    || presentation === undefined
    || presentation.runtime !== state.runtime
    || (expected !== undefined && presentation !== expected)) {
    throw new Error('environment composition: destination Host is not connected')
  }
  return presentation
}

async function withNavigationIntent<T>(
  navigation: EnvironmentCompositionNavigation,
  location: EnvironmentAppLocation,
  signal: AbortSignal | undefined,
  callback: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted === true) throw abortReason(signal, 'Environment presentation was cancelled')
  navigation.open(location)
  const intent = navigation.getSnapshot()
  const superseded = new AbortController()
  const operationSignal = combineSignals(signal, superseded.signal) ?? superseded.signal
  const assertCurrent = (): void => {
    if (operationSignal.aborted) {
      throw abortReason(operationSignal, 'Environment presentation was cancelled')
    }
    if (navigation.getSnapshot() !== intent) {
      throw abortError('Environment presentation navigation was superseded')
    }
  }
  const off = navigation.subscribe(() => {
    if (navigation.getSnapshot() !== intent) {
      superseded.abort(abortError('Environment presentation navigation was superseded'))
    }
  })
  try {
    assertCurrent()
    return await raceWithSignal(callback(assertCurrent, operationSignal), operationSignal)
  } finally {
    off()
  }
}

function waitForRemotePresentation(
  projection: ActiveEnvironmentRuntimeProjection,
  presentation: () => ActivePresentation | undefined,
  environmentId: EnvironmentId,
  signal: AbortSignal | undefined,
): Promise<ActivePresentation> {
  return new Promise<ActivePresentation>((resolve, reject) => {
    let settled = false
    let unsubscribe = (): void => {}
    const finish = (result: { value: ActivePresentation } | { error: unknown }): void => {
      if (settled) return
      settled = true
      unsubscribe()
      signal?.removeEventListener('abort', aborted)
      if ('value' in result) resolve(result.value)
      else reject(asError(result.error, 'Environment presentation resolution failed'))
    }
    const aborted = (): void => {
      finish({ error: abortReason(signal, 'Environment presentation was cancelled') })
    }
    const inspect = (): void => {
      const state = projection.getSnapshot()
      if (state.phase === 'error' && state.environmentId === environmentId) {
        finish({ error: new Error('environment composition: destination activation failed', { cause: state.error }) })
        return
      }
      if (state.phase === 'ready' && state.environmentId === environmentId) {
        const mounted = presentation()
        if (state.connectionState === 'connected'
          && mounted !== undefined
          && mounted.runtime === state.runtime) {
          finish({ value: mounted })
        }
      }
    }
    unsubscribe = projection.subscribe(inspect)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted === true) {
      aborted()
      return
    }
    inspect()
  })
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
}

async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) throw abortReason(signal, 'Environment presentation was cancelled')
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(abortReason(signal, 'Environment presentation was cancelled')) }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted) })
  })
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

function abortReason(signal: AbortSignal | undefined, message: string): Error {
  return asError(signal?.reason, message)
}

function asError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : abortError(message)
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
  return location.kind === 'session' ? location.ref.environmentId
    : location.kind === 'new-session' ? location.environmentId : undefined
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
    clear?(): void
    refresh?(): Promise<void>
  } | undefined
  if (sessions?.list === undefined || sessions.open === undefined) return () => {}
  let stopped = false
  let refreshTarget: string | undefined
  let locationTarget: string | undefined
  let locationHydrated = false
  let blankIntent: EnvironmentAppLocation | undefined
  const sync = (): void => {
    if (stopped) return
    const location = navigation.getSnapshot()
    if (location.kind === 'new-session' && location.environmentId === environmentId) {
      if (blankIntent === location) return
      blankIntent = location
      locationTarget = undefined
      locationHydrated = false
      if (sessions.list?.getSnapshot().current !== undefined) sessions.clear?.()
      return
    }
    blankIntent = undefined
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
    if (current === previous) return
    previous = current
    if (current === undefined) return
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
