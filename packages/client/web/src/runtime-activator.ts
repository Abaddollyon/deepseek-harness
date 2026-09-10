import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import type { BootManifest, ClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import { FIBER_STATE } from './loader-status.ts'
import { PLATFORM_MODULES } from './platform.ts'

/** Reusable activation of trusted client graph entries in an independent Cordis root. */
export interface ClientRuntimeActivator {
  /** Trusted plugin ids present in this concrete boot manifest. */
  available(): readonly string[]
  /**
   * Resolve manifest dependency edges for a trusted activation roster.
   * `provided` marks package faces already represented by projected services.
   */
  deriveRoster(roots: readonly string[], provided?: readonly string[]): readonly string[]
  /** Read Cordis service requirements from the trusted, materialized roster. */
  serviceRequirements(ids: readonly string[]): Promise<readonly string[]>
  /**
   * Activate a dependency-closed plugin roster in a fresh runtime context.
   * @param ctx - independent runtime root.
   * @param ids - trusted manifest plugin ids to activate.
   */
  activate(ctx: Context, ids: readonly string[]): Promise<ClientRuntimeActivation>
  /**
   * Withdraw matching entries from an existing Loader while keeping its
   * other services active. The returned owner restores the exact roster.
   */
  withdraw(ctx: Context, ids: readonly string[]): Promise<ClientRuntimeWithdrawal>
}

/** Owned entries activated in one target context. */
export interface ClientRuntimeActivation {
  /** Remove only entries created by this activation. */
  dispose(): Promise<void>
}

/** Temporarily absent entries from an existing Loader. */
export interface ClientRuntimeWithdrawal {
  /** Restore the withdrawn entries once; subsequent calls are harmless. */
  resume(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared module graph activator used to build independent Host runtimes. */
    clientRuntimeActivator: ClientRuntimeActivator
  }
}

/**
 * Bind the boot module graph to a reusable runtime activator.
 * @param modules - page-owned memoized module system, safe to reuse across contexts.
 * @param manifest - trusted Host client manifest.
 * @returns activator that gives every call a new Loader and event/service tree.
 */
export function createClientRuntimeActivator(
  modules: ClientModuleSystem,
  manifest: BootManifest,
): ClientRuntimeActivator {
  const known = new Set(manifest.plugins.map(row => row.id))
  const staticFaces = new Set<string>(PLATFORM_MODULES)
  const rows = new Map(manifest.plugins.map(row => [row.id, row] as const))
  const assertKnown = (id: string): void => {
    if (!known.has(id)) throw new Error(`client runtime activator: unknown plugin ${JSON.stringify(id)}`)
  }
  return {
    available: () => manifest.plugins.map(row => row.id),
    deriveRoster(roots, provided = []) {
      const boundary = new Set(provided)
      for (const id of roots) assertKnown(id)
      for (const id of boundary) assertKnown(id)
      const selected = new Set<string>()
      const visiting = new Set<string>()
      const visit = (id: string): void => {
        if (boundary.has(id) || selected.has(id)) return
        // Client declarations describe bundle/materialization dependencies,
        // which legitimately contain strongly connected UI package groups.
        // Loader/Cordis resolves their service readiness after every entry is
        // present; closure derivation only needs reachability and therefore
        // stops at an edge already on this traversal stack.
        if (visiting.has(id)) return
        visiting.add(id)
        const row = rows.get(id)
        if (row === undefined) throw new Error(`client runtime activator: unknown dependency ${JSON.stringify(id)}`)
        for (const dependency of row.inject) {
          if (staticFaces.has(dependency)) continue
          assertKnown(dependency)
          visit(dependency)
        }
        visiting.delete(id)
        selected.add(id)
      }
      for (const id of roots) visit(id)
      return manifest.plugins.filter(row => selected.has(row.id)).map(row => row.id)
    },
    async serviceRequirements(ids) {
      const requirements = new Set<string>()
      for (const id of ids) {
        assertKnown(id)
        const raw = await modules.import(id)
        const plugin = unwrapPlugin(raw)
        const inject = plugin?.inject
        if (Array.isArray(inject)) {
          for (const service of inject) if (typeof service === 'string') requirements.add(service)
        } else if (inject !== null && typeof inject === 'object') {
          for (const service of Object.keys(inject)) requirements.add(service)
        }
      }
      return [...requirements]
    },
    async activate(ctx, ids) {
      const requested = [...new Set(ids)]
      for (const id of requested) assertKnown(id)
      if (ctx.get('loader') !== undefined) {
        throw new Error('client runtime activator: target context already has a Loader')
      }
      await ctx.plugin(Loader)
      const loader = ctx.loader
      loader.internal = modules as never
      const created: string[] = []
      try {
        for (const name of requested) {
          const id = await loader.create({ name })
          created.push(id)
          if (loader.resolve(id).fiber === undefined) {
            throw new Error(`client runtime activator: ${JSON.stringify(name)} failed to import`)
          }
        }
        await loader.await()
        assertActive(ctx, loader.entries())
      } catch (error) {
        const cleanupErrors: unknown[] = []
        await removeCreatedEntries(created, loader, cleanupErrors)
        throwWithCleanup(error, cleanupErrors)
      }
      let disposed = false
      return {
        async dispose() {
          if (disposed) return
          disposed = true
          const errors: unknown[] = []
          await removeCreatedEntries(created, loader, errors)
          throwCleanupErrors(errors)
        },
      }
    },
    async withdraw(ctx, ids) {
      const requested = new Set(ids)
      for (const id of requested) assertKnown(id)
      const loader = ctx.get('loader')
      if (loader === undefined) throw new Error('client runtime activator: target context has no Loader')
      const selected = [...loader.entries()].filter(entry => requested.has(entry.options.name))
      const missing = [...requested].filter(name => !selected.some(entry => entry.options.name === name))
      if (missing.length > 0) {
        throw new Error(`client runtime activator: cannot withdraw inactive plugin(s): ${missing.join(', ')}`)
      }
      const saved = selected.map(entry => ({
        options: { ...entry.options, id: undefined },
        position: loader.root.data.indexOf(entry.options),
      }))
      const withdrawalErrors: unknown[] = []
      for (const entry of selected.reverse()) {
        try {
          await loader.remove(entry.id)
        } catch (error) {
          withdrawalErrors.push(error)
        }
      }
      if (withdrawalErrors.length > 0) {
        const restorationErrors: unknown[] = []
        for (const item of saved.sort((left, right) => left.position - right.position)) {
          if ([...loader.entries()].some(entry => entry.options.name === item.options.name)) continue
          const { id: _id, ...options } = item.options
          try {
            await loader.create(options, null, item.position)
          } catch (error) {
            restorationErrors.push(error)
          }
        }
        try {
          await loader.await()
          assertActive(ctx, loader.entries())
        } catch (error) {
          restorationErrors.push(error)
        }
        throwCleanupErrors([...withdrawalErrors, ...restorationErrors])
      }
      let resumed = false
      return {
        async resume() {
          if (resumed) return
          const created: string[] = []
          try {
            for (const item of saved.sort((left, right) => left.position - right.position)) {
              const { id: _id, ...options } = item.options
              created.push(await loader.create(options, null, item.position))
            }
            await loader.await()
            assertActive(ctx, loader.entries())
            resumed = true
          } catch (error) {
            const cleanupErrors: unknown[] = []
            await removeCreatedEntries(created, loader, cleanupErrors)
            throwWithCleanup(error, cleanupErrors)
          }
        },
      }
    },
  }
}

async function removeCreatedEntries(
  created: string[],
  loader: { entries(): Iterable<{ id: string }>; remove(id: string): Promise<void> },
  errors: unknown[],
): Promise<void> {
  for (const id of created.reverse()) {
    if (![...loader.entries()].some(entry => entry.id === id)) continue
    try {
      await loader.remove(id)
    } catch (error) {
      errors.push(error)
    }
  }
}

function throwWithCleanup(error: unknown, cleanupErrors: readonly unknown[]): never {
  if (cleanupErrors.length === 0) throw error
  throw new AggregateError([error, ...cleanupErrors], 'client runtime activator: operation and cleanup failed')
}

function throwCleanupErrors(errors: readonly unknown[]): void {
  if (errors.length === 0) return
  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, 'client runtime activator: multiple cleanup failures')
}

function unwrapPlugin(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const exportedDefault = raw.default
  return typeof exportedDefault === 'object' && exportedDefault !== null
    ? exportedDefault as Record<string, unknown>
    : raw
}

function assertActive(ctx: Context, entries: Iterable<import('@deepseek-ai/cordis-plugin-loader').Entry>): void {
  const failures: string[] = []
  for (const entry of entries) {
    const fiber = entry.fiber
    if (fiber === undefined) {
      failures.push(`${entry.options.name}: import failed`)
      continue
    }
    if (fiber.state === FIBER_STATE.ACTIVE) continue
    const missing = Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
    failures.push(`${entry.options.name}: state ${String(fiber.state)}${missing.length === 0 ? '' : `, missing ${missing.join(', ')}`}`)
  }
  if (failures.length > 0) {
    throw new Error(`client runtime activator: ${String(failures.length)} entry activation failure(s)\n${failures.join('\n')}`)
  }
}
