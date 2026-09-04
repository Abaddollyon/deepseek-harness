/** Lifecycle-owned immutable model metadata snapshots with credential-scoped disk caches.
 * @module dsh-llm-pi-ai/live-catalog
 */
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai'
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
  ready: Promise<void>
  metadata?: readonly PiAiModelProfile[]
  cacheKey?: string
  clientVersion?: string | undefined
  flight?: Promise<void> | undefined
  timer?: ReturnType<typeof setTimeout>
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

/** Shared catalog for selection and dispatch; disposal joins every cache write and fetch. */
export class LiveCatalog {
  private states = new Map<string, RouteState>()
  private pending = new Set<Promise<void>>()
  private raw: Config | undefined
  private snapshot: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  private closed = false
  private authRefresh = new AsyncLocalStorage<RouteState>()

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
          configKey: digest(raw.providers?.[provider]), profile, controller: new AbortController(), ready: Promise.resolve(),
        }
        this.states.set(provider, state)
        state.ready = this.track(this.restore(provider, state))
        this.background(provider, state)
      }
    }
    if (this.snapshot === undefined) {
      this.snapshot = resolveProfiles(raw.providers, new Map([...this.states].flatMap(([provider, state]) =>
        state.metadata === undefined ? [] : [[provider, state.metadata]])))
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

  private async restore(provider: string, state: RouteState): Promise<void> {
    try {
      const [key, credential] = await Promise.all([
        this.options.resolveApiKey(provider, state.profile),
        this.options.auth.credentials.read(provider, { signal: state.controller.signal }),
      ])
      if (!this.valid(provider, state)) return
      state.cacheKey = digest([provider, state.configKey, key, credential])
      const filename = this.filename(state)
      if ((await stat(filename)).size > 4 * 1024 * 1024) return
      const body: unknown = JSON.parse(await readFile(filename, 'utf8'))
      if (typeof body !== 'object' || body === null) return
      const cached = body as { version?: unknown; models?: unknown; clientVersion?: unknown }
      if (cached.version !== 1 || !Array.isArray(cached.models) || cached.models.length === 0 || cached.models.length > 2000) return
      // Resolve durable metadata through the same model validator as profile JSON.
      const models = cached.models as PiAiModelProfile[]
      resolveProfiles(this.raw?.providers, new Map([[provider, models]]))
      if (!this.valid(provider, state)) return
      state.metadata = models
      if (typeof cached.clientVersion === 'string' && /^\d+\.\d+\.\d+$/.test(cached.clientVersion)) {
        state.clientVersion = cached.clientVersion
      }
      this.snapshot = undefined
      this.options.changed()
    } catch {
      // Missing, malformed, or unreadable caches are optional; configured models remain available.
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
      state.flight = this.track(this.fetch(provider, state).finally(() => {
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

  private async fetch(provider: string, state: RouteState): Promise<void> {
    const timeout = new AbortController()
    const timer = setTimeout(() =>{  timeout.abort() }, state.profile.modelDiscovery?.timeoutMs ?? 15_000)
    const signal = AbortSignal.any([state.controller.signal, timeout.signal])
    try {
      await state.ready
      signal.throwIfAborted()
      const apiKey = await this.options.resolveApiKey(provider, state.profile)
      signal.throwIfAborted()
      const models = createModels(this.options.auth)
      models.setProvider(state.profile.piProvider)
      const auth = await this.authRefresh.run(state, () => models.getAuth(provider, {
        signal, ...apiKey === undefined ? {} : { apiKey },
      }))
      signal.throwIfAborted()
      if (auth === undefined) throw new Error('missing model metadata credential')
      const credential = await this.options.auth.credentials.read(provider, { signal })
      state.cacheKey = digest([provider, state.configKey, apiKey, credential])
      const result = await fetchLiveMetadata(state.profile, auth.auth, signal, state.clientVersion)
      this.profiles()
      if (!this.valid(provider, state)) throw new Error('model metadata request superseded')
      const merged = new Map(state.metadata?.map(model => [model.id, model]))
      for (const model of result.models) merged.set(model.id, model)
      const metadata = [...merged.values()]
      if (metadata.length > 2000) throw new Error('retained model metadata exceeds the entry limit')
      resolveProfiles(this.raw?.providers, new Map([[provider, metadata]]))
      const serialized = JSON.stringify({
        version: 1, models: metadata, clientVersion: result.clientVersion,
      })
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('retained model metadata exceeds the byte limit')
      await writeFileAtomic(this.filename(state), serialized, { mode: 0o600, dirMode: 0o700 })
      if (!this.valid(provider, state)) throw new Error('model metadata request superseded')
      state.metadata = metadata
      state.clientVersion = result.clientVersion
      this.snapshot = undefined
      this.options.changed()
    } catch {
      throw new LlmError('model discovery failed; the last available catalog is unchanged', 'DISCOVERY_FAILED')
    } finally {
      clearTimeout(timer)
    }
  }

  /** Fence old account metadata and start discovery with the current credential.
   * @param provider - Route whose credential changed.
   */
  invalidate(provider: string): void {
    const state = this.states.get(provider)
    if (state === undefined) return
    // A committed rotation in this exact getAuth operation already precedes its metadata fetch.
    // Login/logout and another request's rotation run outside this async context and still fence it.
    if (this.authRefresh.getStore() === state) return
    this.stop(state)
    this.states.delete(provider)
    this.raw = undefined
    this.snapshot = undefined
    this.profiles()
  }

  private stop(state: RouteState): void {
    state.controller.abort()
    if (state.timer !== undefined) clearTimeout(state.timer)
  }

  /** Stop timers, abort provider work, and await all pending I/O. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const state of this.states.values()) this.stop(state)
    await Promise.allSettled([...this.pending])
  }
}
