import type { Context } from '@deepseek-ai/cordis'
import type { EnvironmentId, HostGeneration } from './identity.ts'
import type { EnvironmentRequestHandle } from './request.ts'

/** Observable current generation of one environment runtime. */
export interface HostGenerationSource {
  /** Current ready generation, absent while disconnected. */
  getSnapshot(): HostGeneration | undefined
  /** Subscribe to generation establishment, replacement, and loss. */
  subscribe(listener: () => void): () => void
}

/** Independently activated client service tree for one Host environment. */
export interface EnvironmentRuntime {
  /** Immutable Host environment identity. */
  readonly environmentId: EnvironmentId
  /** Unique identity for this runtime incarnation. */
  readonly runtimeId: string
  /** Independent Cordis root containing Host-scoped services and caches. */
  readonly context: Context
  /** Runtime-bound feature request service. */
  readonly request: EnvironmentRequestHandle
  /** Runtime generation projected with Host and runtime identity. */
  readonly generation: HostGenerationSource
  /** Reach quiescence and release the whole runtime tree. */
  dispose(): Promise<void>
}

/** Factory used by the registry to activate one independent runtime. */
export type EnvironmentRuntimeFactory = (environmentId: EnvironmentId) => Promise<EnvironmentRuntime>

/** One acquired runtime and its idempotent reference release. */
export interface EnvironmentRuntimeLease {
  /** Shared runtime for the acquired Host. */
  readonly runtime: EnvironmentRuntime
  /** Release this caller's ownership. */
  release(): Promise<void>
}

/** Reference-counted environment runtime owner. */
export interface EnvironmentRuntimeRegistry {
  /**
   * Acquire the runtime for one Host, creating it once across concurrent callers.
   * @param environmentId - Host environment to activate.
   * @returns caller-owned runtime lease.
   */
  acquire(environmentId: EnvironmentId): Promise<EnvironmentRuntimeLease>
  /** Read an already activated runtime without acquiring ownership. */
  get(environmentId: EnvironmentId): EnvironmentRuntime | undefined
  /** Reject pending acquisition and dispose every activated runtime. */
  dispose(): Promise<void>
}

interface RuntimeEntry {
  readonly promise: Promise<EnvironmentRuntime>
  runtime?: EnvironmentRuntime
  leases: number
  disposing?: Promise<void>
}

/** Options for {@link createEnvironmentRuntimeRegistry}. */
export interface EnvironmentRuntimeRegistryOptions {
  /** Activate one complete Host-scoped client service tree. */
  readonly createRuntime: EnvironmentRuntimeFactory
}

/**
 * Create a reference-counted owner of independent Host runtimes.
 * @param options - runtime activation factory.
 * @returns registry with deduplicated acquisition and quiescent disposal.
 */
export function createEnvironmentRuntimeRegistry(
  options: EnvironmentRuntimeRegistryOptions,
): EnvironmentRuntimeRegistry {
  const entries = new Map<EnvironmentId, RuntimeEntry>()
  let disposed = false

  const disposeEntry = async (environmentId: EnvironmentId, entry: RuntimeEntry): Promise<void> => {
    if (entry.disposing !== undefined) return entry.disposing
    if (entries.get(environmentId) === entry) entries.delete(environmentId)
    entry.disposing = entry.promise.then(async (runtime) => {
      entry.runtime = runtime
      await runtime.dispose()
    }, () => {})
    return entry.disposing
  }

  return {
    async acquire(environmentId) {
      if (disposed) throw new Error('environment runtime registry is disposed')
      let entry = entries.get(environmentId)
      if (entry === undefined) {
        entry = {
          promise: Promise.resolve().then(() => options.createRuntime(environmentId)),
          leases: 0,
        }
        entries.set(environmentId, entry)
      }
      entry.leases += 1
      let runtime: EnvironmentRuntime
      try {
        runtime = await entry.promise
        entry.runtime = runtime
      } catch (error) {
        entry.leases -= 1
        if (entries.get(environmentId) === entry) entries.delete(environmentId)
        throw error
      }
      if (disposed || entry.disposing !== undefined) {
        entry.leases -= 1
        await disposeEntry(environmentId, entry)
        throw new Error('environment runtime registry is disposed')
      }
      let released = false
      return {
        runtime,
        async release() {
          if (released) return
          released = true
          entry.leases -= 1
          if (entry.leases === 0) await disposeEntry(environmentId, entry)
        },
      }
    },
    get(environmentId) {
      return entries.get(environmentId)?.runtime
    },
    async dispose() {
      if (disposed) return
      disposed = true
      await Promise.all([...entries].map(([environmentId, entry]) => disposeEntry(environmentId, entry)))
    },
  }
}
