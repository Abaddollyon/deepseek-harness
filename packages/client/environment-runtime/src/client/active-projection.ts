import type { EnvironmentId } from './identity.ts'
import type {
  EnvironmentRuntime,
  EnvironmentRuntimeLease,
  EnvironmentRuntimeRegistry,
} from './registry.ts'
import { failureAfterCleanup, runCleanupSteps } from './cleanup.ts'

/** Connection readiness of the selected Host while its presentation remains mounted. */
export type EnvironmentConnectionState = 'connecting' | 'connected' | 'disconnected'

/** Observable selected Host identity derived from shell navigation. */
export interface EnvironmentSelectionSource {
  /** Host selected by the current shell location. */
  getSnapshot(): EnvironmentId | undefined
  /** Subscribe to selected Host changes. */
  subscribe(listener: () => void): () => void
}

/** Current selected-runtime presentation activation. */
export type ActiveEnvironmentRuntimeState =
  | { readonly phase: 'idle'; readonly activeEnvironmentId?: EnvironmentId }
  | {
    readonly phase: 'loading'
    readonly environmentId: EnvironmentId
    /** Host whose presentation graph is currently committed, if remote. */
    readonly activeEnvironmentId?: EnvironmentId
  }
  | {
    readonly phase: 'ready'
    readonly environmentId: EnvironmentId
    readonly activeEnvironmentId: EnvironmentId
    readonly runtime: EnvironmentRuntime
    readonly connectionState: EnvironmentConnectionState
    readonly lastConnectedAt?: number
  }
  | {
    readonly phase: 'error'
    readonly environmentId: EnvironmentId
    readonly activeEnvironmentId?: EnvironmentId
    readonly error: unknown
  }

/** Owns one selected runtime's registrations in the persistent shell. */
export interface ActiveEnvironmentRuntimeProjection {
  /** Current activation phase and selected runtime. */
  getSnapshot(): ActiveEnvironmentRuntimeState
  /** Subscribe to selected-runtime activation changes. */
  subscribe(listener: () => void): () => void
  /** Await the latest selection transition. */
  whenIdle(): Promise<void>
  /** Retry the current failed or disconnected selection. */
  retry(): void
  /** Withdraw active UI registrations and release the selected runtime lease. */
  dispose(): Promise<void>
}

/** Options for {@link createActiveEnvironmentRuntimeProjection}. */
export interface ActiveEnvironmentRuntimeProjectionOptions {
  /** Reference-counted owner of Host runtimes. */
  readonly registry: EnvironmentRuntimeRegistry
  /** Navigation-derived selected Host. */
  readonly selection: EnvironmentSelectionSource
  /**
   * Mount UI registrations against the runtime's domain services and the shell's renderer seats.
   * @param runtime - selected Host runtime whose context owns domain services and events.
   * @param signal - aborted when another Host wins or the projection disposes.
   * @returns disposer that withdraws every registration before the runtime lease releases.
   */
  readonly activate: (
    runtime: EnvironmentRuntime,
    signal: AbortSignal,
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  /** Wall clock sampled when a generation first becomes ready. */
  readonly now?: () => number
  /** Hold persistent-shell root sources and scope adapters stable across an async UI graph swap. */
  readonly holdTransition?: () => () => void
}

interface ActiveMount {
  readonly lease: EnvironmentRuntimeLease
  readonly dispose: () => void | Promise<void>
  readonly unsubscribeConnection: () => void
}

/**
 * Bind exactly one Host runtime's UI composition into a persistent shell.
 * @param options - runtime registry, selected Host source, and UI activator.
 * @returns lifecycle owner with last-selection-wins fencing.
 */
export function createActiveEnvironmentRuntimeProjection(
  options: ActiveEnvironmentRuntimeProjectionOptions,
): ActiveEnvironmentRuntimeProjection {
  let state: ActiveEnvironmentRuntimeState = { phase: 'idle' }
  let revision = 0
  let disposed = false
  let active: ActiveMount | undefined
  let transition: Promise<void> = Promise.resolve()
  let transitionAbort: AbortController | undefined
  let requested: EnvironmentId | undefined
  let hasRequested = false
  const listeners = new Set<() => void>()

  const publish = (next: ActiveEnvironmentRuntimeState): void => {
    state = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[environment-runtime] active projection listener threw:', error)
      }
    }
  }

  const releaseMount = async (mount: ActiveMount): Promise<void> => {
    await runCleanupSteps([
      mount.unsubscribeConnection,
      mount.dispose,
      mount.lease.release,
    ])
  }

  const superseded = (ownRevision: number, abort: AbortController): boolean =>
    disposed || revision !== ownRevision || abort.signal.aborted

  const connectionOf = (runtime: EnvironmentRuntime): {
    state?: {
      getSnapshot(): EnvironmentConnectionState | undefined
      subscribe(listener: () => void): () => void
    }
    reconnect?(): void
  } | undefined => runtime.context.get('connection') as {
    state?: {
      getSnapshot(): EnvironmentConnectionState | undefined
      subscribe(listener: () => void): () => void
    }
    reconnect?(): void
  } | undefined

  const watchConnection = (
    environmentId: EnvironmentId,
    runtime: EnvironmentRuntime,
    ownRevision: number,
  ): (() => void) => {
    const connection = connectionOf(runtime)
    let lastConnectedAt: number | undefined
    let previousState: EnvironmentConnectionState | undefined
    const update = (): void => {
      if (disposed || revision !== ownRevision || active?.lease.runtime !== runtime) return
      const generationReady = runtime.generation.getSnapshot() !== undefined
      const reported = connection?.state?.getSnapshot()
      const connectionState: EnvironmentConnectionState = generationReady
        ? 'connected'
        : reported === 'connecting' || reported === undefined
          ? 'connecting'
          : 'disconnected'
      if (generationReady && previousState !== 'connected') {
        lastConnectedAt = (options.now ?? Date.now)()
      }
      previousState = connectionState
      publish({
        phase: 'ready', environmentId, activeEnvironmentId: environmentId, runtime, connectionState,
        ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
      })
    }
    const offGeneration = runtime.generation.subscribe(update)
    const offState = connection?.state?.subscribe(update) ?? (() => {})
    update()
    return () => {
      offState()
      offGeneration()
    }
  }

  const select = (): void => {
    const selected = options.selection.getSnapshot()
    if (hasRequested && selected === requested) return
    requested = selected
    hasRequested = true
    const ownRevision = ++revision
    transitionAbort?.abort()
    const abort = new AbortController()
    transitionAbort = abort
    const preceding = transition
    transition = preceding.catch(() => {}).then(async () => {
      if (superseded(ownRevision, abort)) return
      if (selected === undefined) {
        const releaseTransition = options.holdTransition?.()
        const previous = active
        active = undefined
        try {
          let cleanupError: unknown
          try {
            if (previous !== undefined) await releaseMount(previous)
          } catch (error) {
            cleanupError = error
          }
          if (!superseded(ownRevision, abort)) publish({ phase: 'idle' })
          if (cleanupError !== undefined) throw cleanupError
        } finally {
          releaseTransition?.()
        }
        return
      }
      publish({
        phase: 'loading', environmentId: selected,
        ...(active === undefined ? {} : { activeEnvironmentId: active.lease.runtime.environmentId }),
      })
      let lease: EnvironmentRuntimeLease | undefined
      let disposeActivation: (() => void | Promise<void>) | undefined
      let releaseTransition: (() => void) | undefined
      try {
        lease = await options.registry.acquire(selected)
        if (superseded(ownRevision, abort)) {
          await lease.release()
          return
        }
        releaseTransition = options.holdTransition?.()
        const previous = active
        active = undefined
        if (previous !== undefined) await releaseMount(previous)
        if (superseded(ownRevision, abort)) {
          await lease.release()
          return
        }
        const result = await options.activate(lease.runtime, abort.signal)
        disposeActivation = result ?? (() => {})
        if (superseded(ownRevision, abort)) {
          await disposeActivation()
          await lease.release()
          return
        }
        active = { lease, dispose: disposeActivation, unsubscribeConnection: () => {} }
        active = {
          ...active,
          unsubscribeConnection: watchConnection(selected, lease.runtime, ownRevision),
        }
      } catch (error) {
        const failure = await failureAfterCleanup(error, [
          ...(disposeActivation === undefined ? [] : [disposeActivation]),
          ...(lease === undefined ? [] : [lease.release]),
        ])
        if (!superseded(ownRevision, abort)) {
          publish({ phase: 'error', environmentId: selected, error: failure })
        }
      } finally {
        releaseTransition?.()
      }
    })
  }

  const unsubscribe = options.selection.subscribe(select)
  select()
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    whenIdle: () => transition,
    retry() {
      if (disposed) return
      if (state.phase === 'ready' && state.connectionState !== 'connected') {
        connectionOf(state.runtime)?.reconnect?.()
        publish({ ...state, connectionState: 'connecting' })
        return
      }
      hasRequested = false
      select()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      revision += 1
      transitionAbort?.abort()
      unsubscribe()
      const previous = active
      active = undefined
      try {
        await runCleanupSteps([
          () => transition,
          ...(previous === undefined ? [] : [() => releaseMount(previous)]),
        ])
      } finally {
        listeners.clear()
      }
    },
  }
}
