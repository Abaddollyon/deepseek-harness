import { Context } from '@deepseek-ai/cordis'
import type { EnvironmentRuntime } from './registry.ts'
import { failureAfterCleanup, runCleanupSteps } from './cleanup.ts'

/** A selected Host's UI composition projected into the persistent shell. */
export interface EnvironmentPresentationMount {
  /** Isolated presentation context containing only the explicitly projected services. */
  readonly context: Context
  /** Withdraw registrations and discard the presentation context. */
  dispose(): Promise<void>
}

/** Inputs for one selected-runtime presentation composition. */
export interface EnvironmentPresentationMountOptions {
  /** Runtime that owns all domain services and authority for this UI. */
  readonly runtime: EnvironmentRuntime
  /** Persistent application shell that owns renderer, slots, locale, and layout. */
  readonly shell: Context
  /** Domain service names copied from the owning runtime. */
  readonly runtimeServices: readonly string[]
  /** Presentation service names copied from the persistent shell. */
  readonly shellServices: readonly string[]
  /** Selection lifetime; activation must stop when a newer selection wins. */
  readonly signal: AbortSignal
  /** Activate a dependency-closed UI roster or direct registrations. */
  readonly activate: (
    context: Context,
    signal: AbortSignal,
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
}

/**
 * Compose a selected Host's UI below one persistent shell.
 *
 * The presentation context gets domain service objects only from `runtime`
 * and renderer-facing services only from `shell`. It never owns either
 * source context, so switching Hosts withdraws UI registrations without
 * disposing the renderer or a separately retained Host runtime.
 */
export async function createEnvironmentPresentationMount(
  options: EnvironmentPresentationMountOptions,
): Promise<EnvironmentPresentationMount> {
  if (options.signal.aborted) throw abortError()
  const context = new Context()
  let activationDispose: (() => void | Promise<void>) | undefined
  let disposed = false
  try {
    const runtimeServices = new Set(options.runtimeServices)
    if (options.runtime.context.get('environmentRuntime') !== undefined) {
      runtimeServices.add('environmentRuntime')
    }
    const occupied = new Set<string>()
    projectServices(context, options.runtime.context, runtimeServices, occupied, 'runtime')
    projectServices(context, options.shell, options.shellServices, occupied, 'shell')
    const result = await options.activate(context, options.signal)
    activationDispose = result ?? (() => {})
    if (options.signal.aborted) throw abortError()
  } catch (error) {
    throw await failureAfterCleanup(error, [
      ...(activationDispose === undefined ? [] : [activationDispose]),
      () => context.fiber.dispose(),
    ])
  }
  return {
    context,
    async dispose() {
      if (disposed) return
      disposed = true
      await runCleanupSteps([
        () => activationDispose?.(),
        () => context.fiber.dispose(),
      ])
    },
  }
}

function projectServices(
  target: Context,
  source: Context,
  names: Iterable<string>,
  occupied: Set<string>,
  owner: 'runtime' | 'shell',
): void {
  for (const name of names) {
    if (occupied.has(name)) {
      throw new Error(`environment presentation: service ${JSON.stringify(name)} is projected by both runtime and shell`)
    }
    const value = source.get(name)
    if (value === undefined) {
      throw new Error(`environment presentation: ${owner} service ${JSON.stringify(name)} is unavailable`)
    }
    occupied.add(name)
    target.reflect.provide(name, value)
  }
}

function abortError(): Error {
  return new DOMException('Environment presentation activation was superseded', 'AbortError')
}
