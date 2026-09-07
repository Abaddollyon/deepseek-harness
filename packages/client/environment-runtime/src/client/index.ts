import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createEnvironmentCompositionService } from './composition.ts'
import type { HostGeneration } from './identity.ts'
import { createEnvironmentNavigation } from './navigation.ts'
import {
  createEnvironmentPresentationStore, MAX_PRESENTATION_STORAGE_UNITS,
} from './presentation-state.ts'
import type { HostGenerationSource } from './registry.ts'
import { createEnvironmentRequest } from './request.ts'
import type { RuntimeEnvironment } from './runtime.ts'

export type { EnvironmentId, HostGeneration, SessionRef } from './identity.ts'
export { sessionKey } from './identity.ts'
export type {
  EnvironmentRequest, EnvironmentRequestCarrier, EnvironmentRequestHandle, EnvironmentRequestOptions,
} from './request.ts'
export { createEnvironmentRequest } from './request.ts'
export type {
  EnvironmentRuntime, EnvironmentRuntimeFactory, EnvironmentRuntimeLease, EnvironmentRuntimeRegistry,
  EnvironmentRuntimeRegistryOptions, HostGenerationSource,
} from './registry.ts'
export { createEnvironmentRuntimeRegistry } from './registry.ts'
export type {
  CreateEnvironmentRuntimeOptions, RuntimeEnvironment, RuntimeGenerationSource,
} from './runtime.ts'
export { createEnvironmentRuntime } from './runtime.ts'
export type {
  ActiveEnvironmentRuntimeProjection, ActiveEnvironmentRuntimeProjectionOptions,
  ActiveEnvironmentRuntimeState, EnvironmentConnectionState, EnvironmentSelectionSource,
} from './active-projection.ts'
export { createActiveEnvironmentRuntimeProjection } from './active-projection.ts'
export { createEnvironmentPresentationMount } from './presentation-mount.ts'
export type {
  EnvironmentPresentationMount, EnvironmentPresentationMountOptions,
} from './presentation-mount.ts'
export { createEnvironmentCompositionService } from './composition.ts'
export type {
  EnvironmentAppLocation, EnvironmentClientCarrier, EnvironmentClientCarrierFactory,
  EnvironmentClientRuntimeActivator, EnvironmentComposition, EnvironmentCompositionNavigation,
  EnvironmentCompositionOptions, EnvironmentCompositionService, EnvironmentPresentationCallback,
  EnvironmentPresentationResolutionOptions, EnvironmentRosterSpec,
} from './composition.ts'
export type { AppLocation, EnvironmentNavigation, EnvironmentNavigationService } from './navigation.ts'
export { createEnvironmentNavigation, environmentSelection } from './navigation.ts'
export type {
  EnvironmentPresentationStore, EnvironmentSidebarMode, SessionPresentationState,
} from './presentation-state.ts'
export { createEnvironmentPresentationStore } from './presentation-state.ts'

/** Required local Connection services. */
export const inject = ['connection', 'connectionFactory']

let localRuntimeSequence = 0
const PRESENTATION_STORAGE_KEY = 'dsh.environment-navigation.presentation.v1'
const PRESENTATION_WRITE_DELAY_MS = 250

function readPersistedPresentation(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    return localStorage.getItem(PRESENTATION_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function persistPresentation(value: string): void {
  if (value.length > MAX_PRESENTATION_STORAGE_UNITS) return
  try {
    localStorage.setItem(PRESENTATION_STORAGE_KEY, value)
  } catch {
    // Persistence is best-effort; storage denial or quota must not block presentation updates.
  }
}

/**
 * Install the local Host's runtime identity and feature-request seat.
 * @param ctx - local client root carrying its own Connection.
 */
export function apply(ctx: Context): void {
  const environmentId = 'local'
  const runtimeId = `local-runtime-${++localRuntimeSequence}`
  const connection = ctx.get('connection') as ConnectionHandle
  const generation: HostGenerationSource = {
    getSnapshot: (): HostGeneration | undefined => {
      const current = connection.generation.getSnapshot()
      return current === undefined
        ? undefined
        : { environmentId, runtimeId, generation: current.id }
    },
    subscribe: listener => connection.generation.subscribe(listener),
  }
  const request = createEnvironmentRequest({
    environmentId,
    request: async (_boundEnvironmentId, path, init) => globalThis.fetch(path, init),
    generation: () => connection.generation.getSnapshot()?.id,
  })
  const service: RuntimeEnvironment = {
    environmentId,
    runtimeId,
    generation,
    request: request.request.bind(request),
    registerFeatureRoute: request.registerRoute.bind(request),
  }
  const stored = readPersistedPresentation()
  const presentation = createEnvironmentPresentationStore(stored)
  ctx.effect(() => () => { presentation.dispose() }, 'environment-runtime: presentation sources')
  const navigation = {
    ...createEnvironmentNavigation({ kind: 'environments' }),
    presentation,
  }
  ctx.provide('environmentRuntime', service)
  ctx.provide('environmentNavigation', navigation)
  ctx.provide('environmentComposition', createEnvironmentCompositionService(ctx))
  ctx.effect(() => () => { request.dispose() }, 'environment-runtime: local feature requests')
  const syncLocationPresentation = (): void => {
    const location = navigation.getSnapshot()
    if (location.kind === 'session') presentation.update(location.ref, { viewId: location.viewId })
  }
  ctx.effect(() => navigation.subscribe(syncLocationPresentation), 'environment-runtime: location presentation state')
  syncLocationPresentation()
  if (typeof localStorage !== 'undefined') {
    ctx.effect(() => {
      let dirty = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const flush = (): void => {
        if (!dirty) return
        dirty = false
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        persistPresentation(presentation.serialize())
      }
      const schedule = (): void => {
        dirty = true
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(flush, PRESENTATION_WRITE_DELAY_MS)
      }
      const removeSubscription = presentation.subscribe(schedule)
      const pagehide = (): void => { flush() }
      const pageLifecycle = globalThis as unknown as {
        addEventListener?: (type: string, listener: () => void) => void
        removeEventListener?: (type: string, listener: () => void) => void
      }
      pageLifecycle.addEventListener?.('pagehide', pagehide)
      return () => {
        removeSubscription()
        pageLifecycle.removeEventListener?.('pagehide', pagehide)
        flush()
        if (timer !== undefined) clearTimeout(timer)
      }
    }, 'environment-runtime: environment presentation persistence')
  }
}
