import type { EnvironmentId, SessionRef } from './identity.ts'
import type { EnvironmentSelectionSource } from './active-projection.ts'
import type { EnvironmentPresentationStore } from './presentation-state.ts'

/** Shell location selected independently of any Host connection lifecycle. */
export type AppLocation =
  | { readonly kind: 'environments'; readonly selectedId?: EnvironmentId }
  | { readonly kind: 'session'; readonly ref: SessionRef; readonly viewId: string }
  | { readonly kind: 'new-session'; readonly environmentId: EnvironmentId; readonly viewId: string }

/** Persistent-shell navigation over environment overview and Session content. */
export interface EnvironmentNavigation {
  /** Open one overview or exact Host Session location. */
  open(location: AppLocation): void
  /**
   * Open only after a required connection or identity operation succeeds.
   * @param readiness - prerequisite operation.
   * @param location - destination committed after readiness.
   */
  openWhen(readiness: Promise<unknown>, location: AppLocation): Promise<void>
  /** @returns whether a conversation has been opened in this shell. */
  canBackToSession(): boolean
  /** Restore the most recently opened conversation, including a blank conversation. */
  backToSession(): void
  /** Restore the preceding location without disposing its Host runtime. */
  back(): void
  /** Read the current immutable location. */
  getSnapshot(): AppLocation
  /** Subscribe to location changes. */
  subscribe(listener: () => void): () => void
}

/** Persistent navigation and presentation state owned by the application shell. */
export interface EnvironmentNavigationService extends EnvironmentNavigation {
  /** Compound Host/Session presentation state retained across UI remounts. */
  readonly presentation: EnvironmentPresentationStore
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent-shell environment navigation. */
    environmentNavigation: EnvironmentNavigationService
  }
}

/**
 * Create navigation for one persistent application shell.
 * @param initialLocation - first overview or Session location.
 * @returns history-backed observable navigation.
 */
export function createEnvironmentNavigation(initialLocation: AppLocation): EnvironmentNavigation {
  let current = snapshot(initialLocation)
  const history: AppLocation[] = []
  let lastSession = current.kind === 'environments' ? undefined : current
  let intentRevision = 0
  const listeners = new Set<() => void>()
  const publish = (next: AppLocation): void => {
    current = snapshot(next)
    if (current.kind !== 'environments') lastSession = current
    for (const listener of [...listeners]) listener()
  }
  return {
    open(location) {
      intentRevision += 1
      history.push(current)
      publish(location)
    },
    async openWhen(readiness, location) {
      const ownRevision = ++intentRevision
      await readiness
      if (ownRevision !== intentRevision) return
      history.push(current)
      publish(location)
    },
    canBackToSession: () => lastSession !== undefined,
    backToSession() {
      if (lastSession === undefined) return
      intentRevision += 1
      history.push(current)
      publish(lastSession)
    },
    back() {
      intentRevision += 1
      const prior = history.pop()
      if (prior !== undefined) publish(prior)
    },
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * Project the Host that owns the open Session for active-runtime composition.
 * Overview card selection remains local control-plane state and does not
 * acquire or project a remote runtime.
 * @param navigation - persistent-shell navigation source.
 * @returns selected Host source suitable for `createActiveEnvironmentRuntimeProjection`.
 */
export function environmentSelection(navigation: EnvironmentNavigation): EnvironmentSelectionSource {
  return {
    getSnapshot: () => {
      const location = navigation.getSnapshot()
      return location.kind === 'session' ? location.ref.environmentId
        : location.kind === 'new-session' ? location.environmentId : undefined
    },
    subscribe: listener => navigation.subscribe(listener),
  }
}

function snapshot(location: AppLocation): AppLocation {
  if (location.kind === 'new-session') return Object.freeze({ ...location })
  return location.kind === 'environments'
    ? Object.freeze({
      kind: 'environments' as const,
      ...(location.selectedId === undefined ? {} : { selectedId: location.selectedId }),
    })
    : Object.freeze({
      kind: 'session' as const,
      ref: Object.freeze({ ...location.ref }),
      viewId: location.viewId,
    })
}
