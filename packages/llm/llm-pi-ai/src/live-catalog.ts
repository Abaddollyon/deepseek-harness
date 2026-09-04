/** Lifecycle-owned immutable model metadata snapshots with credential-scoped disk caches.
 * @module dsh-llm-pi-ai/live-catalog
 */
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthContext, AuthResult, Credential } from '@earendil-works/pi-ai'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { PiAiAuthInjection } from './adapter.ts'
import type { Config, PiAiModelProfile, ResolvedPiAiProviderProfile } from './config.ts'
import { resolveProfiles } from './config.ts'
import { fetchLiveMetadata } from './live-metadata.ts'

interface RouteState {
  configKey: string
  profile: ResolvedPiAiProviderProfile
  controller: AbortController
  restored: boolean
  references: Set<string>
  identified: boolean
  metadata?: readonly PiAiModelProfile[]
  excludedIds?: readonly string[]
  cacheKey?: string
  persistedKey?: string
  writeSequence: number
  clientVersion?: string | undefined
  flight?: Promise<void> | undefined
  initialization?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}

interface Renewal {
  state: RouteState
  from?: string
  to?: string
}

/** Dependencies already owned by the adapter plugin. */
export interface LiveCatalogOptions {
  current: () => Config
  auth: PiAiAuthInjection
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  home: string
  warn: (provider: string) => void
  changed: () => void
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Bound callers even when a read-only dependency cannot cancel its underlying work. */
function within<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(new Error('model discovery operation aborted')) }
    signal.addEventListener('abort', abort, { once: true })
    let operation: Promise<T>
    try { operation = start() } catch (error) {
      signal.removeEventListener('abort', abort)
      reject(error instanceof Error ? error : new Error('model discovery dependency failed'))
      return
    }
    void operation.then((value) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(new Error('model discovery operation aborted'))
      else resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(error instanceof Error ? error : new Error('model discovery dependency failed'))
    })
  })
}

/** Shared catalog for selection and dispatch; disposal joins every cache write and fetch. */
export class LiveCatalog {
  private states = new Map<string, RouteState>()
  private pending = new Set<Promise<void>>()
  private diskWrites = new Set<Promise<void>>()
  private cacheCommits = new Map<string, Promise<void>>()
  private raw: Config | undefined
  private snapshot: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  private closed = false
  private authRefresh = new AsyncLocalStorage<Renewal>()

  constructor(private readonly options: LiveCatalogOptions) {}

  /** Current immutable effective profiles; new route configuration fences old work synchronously.
   * @returns Shared provider snapshots, including the last complete live metadata.
   */
  profiles(): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
    const raw = this.options.current()
    if (this.raw !== raw) {
      const resolved = resolveProfiles(raw.providers)
      this.raw = raw
      this.snapshot = undefined
      for (const [provider, state] of this.states) {
        const source = raw.providers?.[provider]
        if (source?.modelDiscovery?.enabled !== true || digest(source) !== state.configKey) {
          this.stop(state)
          this.states.delete(provider)
        }
      }
      if (!this.closed) for (const [provider, profile] of resolved) {
        if (profile.modelDiscovery?.enabled !== true || this.states.has(provider)) continue
        const state: RouteState = {
          configKey: digest(raw.providers?.[provider]), profile, controller: new AbortController(), restored: false,
          writeSequence: 0,
          references: new Set(profile.apiKeyEnv === undefined ? [] : [profile.apiKeyEnv]), identified: false,
        }
        this.states.set(provider, state)
        this.background(provider, state)
      }
    }
    if (this.snapshot === undefined) {
      this.snapshot = resolveProfiles(raw.providers, new Map([...this.states].flatMap(([provider, state]) =>
        state.metadata === undefined ? [] : [[provider, state.metadata]])),
      new Map([...this.states].map(([provider, state]) => [provider, state.excludedIds ?? []])))
    }
    return this.snapshot
  }

  private track(promise: Promise<void>): Promise<void> {
    this.pending.add(promise)
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise))
    return promise
  }

  private valid(provider: string, state: RouteState): boolean {
    return !this.closed && !state.controller.signal.aborted && this.states.get(provider) === state
  }

  private authContext(state: RouteState, signal: AbortSignal): AuthContext {
    return {
      ...this.options.auth.authContext,
      env: async (name) => {
        signal.throwIfAborted()
        state.references.add(name)
        return within(signal, () => this.options.auth.authContext.env(name))
      },
    }
  }

  private identity(state: RouteState, key: string | undefined, credential: Credential | undefined, auth?: AuthResult): string {
    const identity = key === undefined && credential?.type === 'oauth' ? credential : [auth?.auth, auth?.env]
    return digest(['effective-auth-v2', state.profile.provider, state.configKey, identity])
  }

  /** Observe only trusted renewal consumers: Models.getAuth and adapter auth recovery, never login.
   * @returns Auth injection preserving verified serialized OAuth predecessor/successor continuity.
   */
  renewalAuth(): PiAiAuthInjection {
    const source = this.options.auth.credentials
    return { ...this.options.auth, credentials: {
      read: (id, options) => source.read(id, options),
      list: options => source.list(options),
      delete: (id, options) => source.delete(id, options),
      modify: async (provider, mutate, options) => {
        this.profiles()
        const state = this.states.get(provider)
        if (state === undefined) return source.modify(provider, mutate, options)
        const signal = options?.signal ?? state.controller.signal
        // A generation can renew before the background cache read has finished.
        // Wait only for restore, not network discovery, so the predecessor is identified.
        const initialization = state.initialization
        if (!state.restored && initialization !== undefined) {
          await within(signal, () => initialization)
        }
        const renewal: Renewal = { state }
        return this.authRefresh.run(renewal, async () => {
          const committed = await source.modify(provider, async (current) => {
            const updated = await mutate(current)
            if (current?.type === 'oauth' && updated?.type === 'oauth') {
              renewal.from = this.identity(state, undefined, current)
              renewal.to = this.identity(state, undefined, updated)
            }
            return updated
          }, options)
          if (this.valid(provider, state) && renewal.from === state.cacheKey && renewal.to !== undefined
            && committed?.type === 'oauth' && this.identity(state, undefined, committed) === renewal.to) {
            state.cacheKey = renewal.to
            try { await this.preserveCache(provider, state, signal) } catch {
              // Auth was committed by its owner. Cache I/O must not turn a valid renewal into auth failure.
              if (this.valid(provider, state)) this.options.warn(provider)
            }
          }
          return committed
        })
      },
    } }
  }

  private async preserveCache(provider: string, state: RouteState, caller: AbortSignal): Promise<void> {
    const key = state.cacheKey
    if (!this.valid(provider, state) || state.metadata === undefined || key === undefined || state.persistedKey === key) return
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort() }, state.profile.modelDiscovery?.timeoutMs ?? 15_000)
    const signal = AbortSignal.any([caller, state.controller.signal, timeout.signal])
    try {
      const sequence = await this.persist(state, JSON.stringify({
        version: 2, models: state.metadata, excludedIds: state.excludedIds ?? [], clientVersion: state.clientVersion,
      }), signal)
      if (this.valid(provider, state) && state.writeSequence === sequence && state.cacheKey === key) state.persistedKey = key
    } finally {
      clearTimeout(timer)
    }
  }

  private async restore(provider: string, state: RouteState, signal: AbortSignal): Promise<void> {
    try {
      const [key, credential] = await Promise.all([
        within(signal, () => this.options.resolveApiKey(provider, state.profile)),
        within(signal, () => this.options.auth.credentials.read(provider, { signal })),
      ])
      if (!this.valid(provider, state)) return
      // API-key resolution reads the same ambient dependencies as dispatch. OAuth identity
      // comes from its stored grant; restoring a cache must never rotate that grant.
      const auth = key === undefined && credential?.type === 'oauth' ? undefined
        : await within(signal, async () => state.profile.piProvider.auth.apiKey?.resolve({
          ctx: this.authContext(state, signal), signal,
          ...key !== undefined ? { credential: { type: 'api_key', key } }
            : credential?.type === 'api_key' ? { credential } : {},
        }))
      signal.throwIfAborted()
      if (!this.valid(provider, state)) return
      state.cacheKey = this.identity(state, key, credential, auth)
      state.identified = true
      const filename = this.filename(state)
      if ((await within(signal, () => stat(filename))).size > 4 * 1024 * 1024) return
      const body: unknown = JSON.parse(await within(signal, () => readFile(filename, { encoding: 'utf8', signal })))
      if (typeof body !== 'object' || body === null) return
      const cached = body as { version?: unknown; models?: unknown; excludedIds?: unknown; clientVersion?: unknown }
      if (cached.version !== 2 || !Array.isArray(cached.models) || !Array.isArray(cached.excludedIds)
        || cached.models.length > 2000 || cached.excludedIds.length > 2000
        || cached.models.length + cached.excludedIds.length === 0) return
      const excludedIds = cached.excludedIds as unknown[]
      if (excludedIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 512)) return
      // Resolve durable metadata through the same model validator as profile JSON.
      const models = cached.models as PiAiModelProfile[]
      const exclusions = excludedIds as string[]
      if (new Set([...models.map(model => model.id), ...exclusions]).size > 2000) return
      resolveProfiles(this.raw?.providers, new Map([[provider, models]]), new Map([[provider, exclusions]]))
      signal.throwIfAborted()
      if (!this.valid(provider, state)) return
      state.metadata = models
      state.excludedIds = exclusions
      state.persistedKey = state.cacheKey
      if (typeof cached.clientVersion === 'string' && /^\d+\.\d+\.\d+$/.test(cached.clientVersion)) {
        state.clientVersion = cached.clientVersion
      }
      this.snapshot = undefined
      this.options.changed()
    } catch {
      // Missing, malformed, or unreadable caches are optional; configured models remain available.
    } finally {
      if (!signal.aborted && this.valid(provider, state)) state.restored = state.identified
    }
  }

  private filename(state: RouteState): string {
    if (state.cacheKey === undefined) throw new Error('model metadata credential has not resolved')
    return join(this.options.home, 'cache', 'llm-pi-ai', `${state.cacheKey}.json`)
  }

  private background(provider: string, state: RouteState): void {
    void this.refresh(provider).catch(() => {
      if (this.valid(provider, state)) this.options.warn(provider)
    })
  }

  /** Give an unknown dispatch ID cache restoration, then one bounded shared discovery attempt.
   * @param provider - Configured provider route.
   * @param model - Exact requested model ID.
   * @param signal - Cancellation of this caller, without cancelling other catalog consumers.
   * @returns Readiness to capture an immutable dispatch snapshot; missing IDs remain missing.
   */
  async ensureModel(provider: string, model: string, signal?: AbortSignal): Promise<void> {
    const present = (): boolean => this.profiles().get(provider)?.piProvider.getModels().some(row => row.id === model) === true
    if (present()) return
    const state = this.states.get(provider)
    if (state === undefined || this.closed) return
    // Observe failure immediately: initialization can complete before the network attempt.
    const refreshed = this.refresh(provider).catch(() => {})
    const waiting = async (): Promise<void> => {
      await state.initialization
      if (!this.valid(provider, state)) throw new LlmError('model lookup superseded', 'ABORTED')
      if (!present()) await refreshed
      if (!this.valid(provider, state)) throw new LlmError('model lookup superseded', 'ABORTED')
    }
    if (signal === undefined) return waiting()
    try { await within(signal, waiting) } catch (error) {
      if (signal.aborted) throw new LlmError('model lookup aborted by caller', 'ABORTED')
      throw error
    }
  }

  /** Refresh a configured route, coalescing concurrent callers and preserving metadata on failure.
   * @param provider - Configured provider route.
   * @param signal - Cancellation for this caller's wait; other callers retain their shared refresh.
   * @returns Settlement after metadata publication and its atomic cache write.
   */
  async refresh(provider: string, signal?: AbortSignal): Promise<void> {
    this.profiles()
    const state = this.states.get(provider)
    if (state === undefined || this.closed) throw new LlmError('model discovery is not enabled for this route', 'DISCOVERY_UNSUPPORTED')
    if (state.flight === undefined) {
      if (state.timer !== undefined) clearTimeout(state.timer)
      const initialized = Promise.withResolvers<void>()
      state.initialization = initialized.promise
      state.flight = this.track(this.fetch(provider, state, () => { initialized.resolve() }).finally(() => {
        state.flight = undefined
        if (this.valid(provider, state)) {
          state.timer = setTimeout(
            () => { this.background(provider, state) }, state.profile.modelDiscovery?.refreshIntervalMs ?? 21_600_000,
          )
          state.timer.unref()
        }
      }))
    }
    if (signal === undefined) return state.flight
    const flight = state.flight
    signal.throwIfAborted()
    return new Promise<void>((resolve, reject) => {
      const abort = (): void =>{  reject(new LlmError('model discovery aborted by caller', 'ABORTED')) }
      signal.addEventListener('abort', abort, { once: true })
      void flight.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    })
  }

  private async fetch(provider: string, state: RouteState, initialized: () => void): Promise<void> {
    const timeout = new AbortController()
    const timer = setTimeout(() =>{  timeout.abort() }, state.profile.modelDiscovery?.timeoutMs ?? 15_000)
    const signal = AbortSignal.any([state.controller.signal, timeout.signal])
    try {
      if (!state.restored) await this.restore(provider, state, signal)
      initialized()
      signal.throwIfAborted()
      const apiKey = await within(signal, () => this.options.resolveApiKey(provider, state.profile))
      signal.throwIfAborted()
      const models = createModels({ ...this.renewalAuth(), authContext: this.authContext(state, signal) })
      models.setProvider(state.profile.piProvider)
      const auth = await within(signal, () => models.getAuth(provider, {
        signal, ...apiKey === undefined ? {} : { apiKey },
      }))
      signal.throwIfAborted()
      if (auth === undefined) throw new Error('missing model metadata credential')
      const credential = await within(signal, () => this.options.auth.credentials.read(provider, { signal }))
      const cacheKey = this.identity(state, apiKey, credential, auth)
      if (state.cacheKey !== cacheKey) {
        delete state.metadata
        delete state.excludedIds
        delete state.clientVersion
        this.snapshot = undefined
      }
      state.cacheKey = cacheKey
      await this.preserveCache(provider, state, signal)
      const result = await within(signal, () => fetchLiveMetadata(state.profile, auth.auth, signal, state.clientVersion))
      this.profiles()
      if (!this.valid(provider, state)) throw new Error('model metadata request superseded')
      const merged = new Map(state.metadata?.map(model => [model.id, model]))
      const excludedIds = new Set(state.excludedIds)
      for (const model of result.models) {
        merged.set(model.id, model)
        excludedIds.delete(model.id)
      }
      for (const id of result.excludedIds) excludedIds.add(id)
      const metadata = [...merged.values()]
      if (new Set([...merged.keys(), ...excludedIds]).size > 2000) throw new Error('retained model metadata exceeds the entry limit')
      resolveProfiles(this.raw?.providers, new Map([[provider, metadata]]), new Map([[provider, [...excludedIds]]]))
      const serialized = JSON.stringify({
        version: 2, models: metadata, excludedIds: [...excludedIds], clientVersion: result.clientVersion,
      })
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('retained model metadata exceeds the byte limit')
      const sequence = await this.persist(state, serialized, signal)
      signal.throwIfAborted()
      if (!this.valid(provider, state) || state.writeSequence !== sequence) throw new Error('model metadata request superseded')
      state.metadata = metadata
      state.excludedIds = [...excludedIds]
      state.persistedKey = state.cacheKey
      state.clientVersion = result.clientVersion
      this.snapshot = undefined
      this.options.changed()
    } catch {
      throw new LlmError('model discovery failed; the last available catalog is unchanged', 'DISCOVERY_FAILED')
    } finally {
      initialized()
      clearTimeout(timer)
    }
  }

  private async persist(state: RouteState, serialized: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    const sequence = ++state.writeSequence
    const check = (): void => {
      signal.throwIfAborted()
      if (sequence !== state.writeSequence) throw new Error('model metadata write superseded')
    }
    const filename = this.filename(state)
    const staging = `${filename}.${randomUUID()}.pending`
    // A write still staging at timeout cannot be promoted. Commit queues
    // serialize non-cancellable renames so an older commit cannot overwrite a newer one.
    const writing = (async () => {
      try {
        await writeFileAtomic(staging, serialized, { mode: 0o600, dirMode: 0o700 })
        check()
        const previous = this.cacheCommits.get(filename) ?? Promise.resolve()
        const commit = previous.catch(() => { /* An earlier failed commit cannot prevent this one. */ }).then(async () => {
          check()
          await rename(staging, filename)
          check()
        })
        this.cacheCommits.set(filename, commit)
        try { await commit } finally {
          if (this.cacheCommits.get(filename) === commit) this.cacheCommits.delete(filename)
        }
      } finally {
        await rm(staging, { force: true })
      }
    })()
    this.diskWrites.add(writing)
    void writing.then(() => this.diskWrites.delete(writing), () => this.diskWrites.delete(writing))
    await within(signal, () => writing)
    return sequence
  }

  /** Fence old account metadata and start discovery with the current credential.
   * @param provider - Route whose credential changed.
   */
  invalidate(provider: string): void {
    const state = this.states.get(provider)
    if (state === undefined) return
    // Only a trusted serialized renewal whose predecessor owns this catalog can retain it.
    // Login/logout and unobserved external replacements still fence the state.
    const renewal = this.authRefresh.getStore()
    if (renewal?.state === state && renewal.from === state.cacheKey && renewal.to !== undefined) return
    this.stop(state)
    this.states.delete(provider)
    this.raw = undefined
    this.snapshot = undefined
    this.profiles()
  }

  /** Invalidate routes that resolve a changed explicit or provider-native credential reference.
   * @param reference - Committed credential reference name.
   */
  invalidateReference(reference: string): void {
    for (const [provider, state] of [...this.states]) {
      if (state.references.has(reference) || !state.identified && state.profile.apiKeyEnv === undefined) this.invalidate(provider)
    }
  }

  /** Fence ambient startup reads when the optional credential service becomes ready. */
  credentialsReady(): void {
    for (const provider of [...this.states.keys()]) this.invalidate(provider)
  }

  private stop(state: RouteState): void {
    state.controller.abort()
    if (state.timer !== undefined) clearTimeout(state.timer)
  }

  /** Stop requests and callbacks; drain started cache writes while detaching uncancellable read-only dependencies. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const state of this.states.values()) this.stop(state)
    await Promise.allSettled([...this.pending])
    await Promise.allSettled([...this.diskWrites])
  }
}
