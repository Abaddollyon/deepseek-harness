import { Context } from '@deepseek-ai/cordis'
import type { ClientTransportHooks, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createEnvironmentRequest, type EnvironmentRequestCarrier } from './request.ts'
import type { EnvironmentId, HostGeneration } from './identity.ts'
import type { EnvironmentRuntime, HostGenerationSource } from './registry.ts'

/** Observable transport generation used to fence one runtime's operations. */
export interface RuntimeGenerationSource {
  /** Current ready generation number, absent while disconnected. */
  getSnapshot(): number | undefined
  /** Subscribe to generation establishment, replacement, and loss. */
  subscribe(listener: () => void): () => void
}

/** Per-runtime Cordis service injected into feature plugins. */
export interface RuntimeEnvironment {
  /** Immutable Host environment identity. */
  readonly environmentId: EnvironmentId
  /** Unique identity for this activation of the Host client tree. */
  readonly runtimeId: string
  /** Current generation including Host and runtime identity. */
  readonly generation: HostGenerationSource
  /** Request a registered feature route from this runtime's Host. */
  readonly request: EnvironmentRuntime['request']['request']
  /**
   * Register a trusted feature route for this plugin's lifetime.
   * @param route - normalized `/api/` route root.
   * @returns disposer withdrawing the route.
   */
  registerFeatureRoute(route: string): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Identity, generation, and feature request seat for this Host runtime. */
    environmentRuntime: RuntimeEnvironment
  }
}

/** Options for activating one complete environment runtime. */
export interface CreateEnvironmentRuntimeOptions {
  /** Immutable Host environment identity. */
  readonly environmentId: EnvironmentId
  /** Environment-aware feature request carrier. */
  readonly request: EnvironmentRequestCarrier
  /** Explicit unary/stream transport installed as this runtime's Connection. */
  readonly connectionTransport?: ClientTransportHooks
  /** Shell Connection factory used when an explicit transport is supplied. */
  readonly createConnection?: (transport: ClientTransportHooks) => ConnectionHandle
  /** Runtime transport generation. */
  readonly generation?: RuntimeGenerationSource
  /** Trusted route roots known before feature plugins activate. */
  readonly registeredRoutes?: readonly string[]
  /** Activate the runtime's client plugin roster in the new Cordis root. */
  readonly activate: (ctx: Context) => void | Promise<void>
  /** Runtime identity source, primarily for deterministic tests. */
  readonly createRuntimeId?: () => string
}

let runtimeSequence = 0

/**
 * Activate one Host's complete client service tree in a fresh Cordis root.
 * @param options - Host transport, generation, route, and plugin activation inputs.
 * @returns independently disposable runtime.
 */
export async function createEnvironmentRuntime(
  options: CreateEnvironmentRuntimeOptions,
): Promise<EnvironmentRuntime> {
  const context = new Context()
  const runtimeId = options.createRuntimeId?.() ?? `environment-runtime-${++runtimeSequence}`
  const connection = options.connectionTransport === undefined
    ? undefined
    : requireConnectionFactory(options.createConnection)(options.connectionTransport)
  if (connection !== undefined) context.provide('connection', connection)
  const runtimeGeneration = options.generation ?? connectionGeneration(connection)
  const currentGeneration = (): number | undefined => runtimeGeneration === undefined
    ? 0
    : runtimeGeneration.getSnapshot()
  const generation: HostGenerationSource = {
    getSnapshot: (): HostGeneration | undefined => {
      const value = currentGeneration()
      return value === undefined
        ? undefined
        : { environmentId: options.environmentId, runtimeId, generation: value }
    },
    subscribe: listener => runtimeGeneration?.subscribe(listener) ?? (() => {}),
  }
  const request = createEnvironmentRequest({
    environmentId: options.environmentId,
    request: options.request,
    generation: currentGeneration,
    ...(options.registeredRoutes === undefined ? {} : { registeredRoutes: options.registeredRoutes }),
  })
  const environmentRuntime: RuntimeEnvironment = {
    environmentId: options.environmentId,
    runtimeId,
    generation,
    request: request.request.bind(request),
    registerFeatureRoute: request.registerRoute.bind(request),
  }
  context.provide('environmentRuntime', environmentRuntime)
  let disposed = false
  try {
    await options.activate(context)
  } catch (error) {
    request.dispose()
    await context.fiber.dispose()
    throw error
  }
  return {
    environmentId: options.environmentId,
    runtimeId,
    context,
    request,
    generation,
    async dispose() {
      if (disposed) return
      disposed = true
      request.dispose()
      await context.fiber.dispose()
    },
  }
}

function requireConnectionFactory(
  create: CreateEnvironmentRuntimeOptions['createConnection'],
): NonNullable<CreateEnvironmentRuntimeOptions['createConnection']> {
  if (create === undefined) {
    throw new Error('environment runtime: an explicit transport requires a Connection factory')
  }
  return create
}

function connectionGeneration(connection: ConnectionHandle | undefined): RuntimeGenerationSource | undefined {
  if (connection === undefined) return undefined
  return {
    getSnapshot: () => connection.generation.getSnapshot()?.id,
    subscribe: listener => connection.generation.subscribe(listener),
  }
}
