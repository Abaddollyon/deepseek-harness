import type { EnvironmentId } from './identity.ts'

/** Runtime-bound feature request service exposed to trusted client plugins. */
export interface EnvironmentRequest {
  /**
   * Send a request to a registered feature path on this service's Host.
   * @param path - Absolute-path relative URL beginning with `/api/`.
   * @param init - Fetch request fields; caller cancellation is composed with runtime disposal.
   * @returns response from the bound Host while the starting generation remains current.
   */
  request(path: string, init?: RequestInit): Promise<Response>
}

/** Environment request service with its runtime-owned teardown. */
export interface EnvironmentRequestHandle extends EnvironmentRequest {
  /**
   * Authorize one feature route for the registering plugin lifetime.
   * @param route - normalized `/api/` route root without query or fragment.
   * @returns disposer withdrawing the authorization.
   */
  registerRoute(route: string): () => void
  /** Abort all outstanding work and reject future requests. */
  dispose(): void
}

/** Carrier whose first argument is injected by the environment-owned factory. */
export type EnvironmentRequestCarrier = (
  environmentId: EnvironmentId,
  path: string,
  init: RequestInit,
) => Promise<Response>

/** Options for {@link createEnvironmentRequest}. */
export interface EnvironmentRequestOptions {
  /** Immutable Host identity bound to every carrier call. */
  readonly environmentId: EnvironmentId
  /** Trusted relative route roots registered for this runtime. */
  readonly registeredRoutes?: readonly string[]
  /** Environment-aware transport carrier. */
  readonly request: EnvironmentRequestCarrier
  /** Current connection generation, when response fencing is required. */
  readonly generation?: () => number | undefined
}

/**
 * Bind feature requests to one Host and one runtime lifetime.
 * @param options - Host identity, trusted route roots, carrier, and optional generation source.
 * @returns request handle whose callers cannot override the Host identity.
 */
export function createEnvironmentRequest(options: EnvironmentRequestOptions): EnvironmentRequestHandle {
  const routes = new Map<string, number>()
  for (const route of options.registeredRoutes ?? []) {
    const normalized = assertRegisteredRoute(route)
    routes.set(normalized, (routes.get(normalized) ?? 0) + 1)
  }
  const lifetime = new AbortController()
  return {
    async request(path, init = {}) {
      if (lifetime.signal.aborted) throw new Error('environment request: runtime is disposed')
      const target = resolveTrustedPath(path, routes.keys())
      const startedGeneration = options.generation?.()
      if (options.generation !== undefined && startedGeneration === undefined) {
        throw new Error('environment request: Host is not connected')
      }
      const signal = combineSignals(lifetime.signal, init.signal)
      const response = await options.request(options.environmentId, target, { ...init, signal })
      // Disposal can abort the lifetime while the carrier request is pending.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (lifetime.signal.aborted) throw new Error('environment request: runtime is disposed')
      if (options.generation !== undefined && options.generation() !== startedGeneration) {
        throw new Error('environment request: Host generation changed before the response arrived')
      }
      return response
    },
    registerRoute(route) {
      if (lifetime.signal.aborted) throw new Error('environment request: runtime is disposed')
      const normalized = assertRegisteredRoute(route)
      routes.set(normalized, (routes.get(normalized) ?? 0) + 1)
      let active = true
      return () => {
        if (!active) return
        active = false
        const remaining = (routes.get(normalized) ?? 1) - 1
        if (remaining === 0) routes.delete(normalized)
        else routes.set(normalized, remaining)
      }
    },
    dispose() {
      lifetime.abort(new Error('environment request: runtime is disposed'))
      routes.clear()
    },
  }
}

function assertRegisteredRoute(route: string): string {
  const pathname = resolvePathname(route)
  if (pathname !== route || !pathname.startsWith('/api/')) {
    throw new Error(`environment request: invalid registered route ${JSON.stringify(route)}`)
  }
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function resolveTrustedPath(path: string, routes: Iterable<string>): string {
  const pathname = resolvePathname(path)
  if (![...routes].some(route => pathname === route || pathname.startsWith(`${route}/`))) {
    throw new Error(`environment request: path is not registered: ${JSON.stringify(pathname)}`)
  }
  return path
}

function resolvePathname(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)) {
    throw new Error(`environment request: expected a relative absolute path, received ${JSON.stringify(path)}`)
  }
  const rawPathname = path.replace(/[?#].*$/su, '')
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPathname)
  } catch {
    throw new Error(`environment request: path has invalid escaping: ${JSON.stringify(path)}`)
  }
  if (decoded.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error(`environment request: path traversal is forbidden: ${JSON.stringify(path)}`)
  }
  const url = new URL(path, 'http://dsh.internal')
  if (url.origin !== 'http://dsh.internal' || url.pathname !== rawPathname) {
    throw new Error(`environment request: path normalization changed the target: ${JSON.stringify(path)}`)
  }
  return url.pathname
}

function combineSignals(lifetime: AbortSignal, caller: AbortSignal | null | undefined): AbortSignal {
  if (caller === undefined || caller === null) return lifetime
  return AbortSignal.any([lifetime, caller])
}
