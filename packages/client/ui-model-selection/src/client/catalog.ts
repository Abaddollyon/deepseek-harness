/** One Host-generation model catalog shared by every Session selector. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Observable lifecycle of the shared model catalog. */
export interface ModelCatalogState {
  value: ModelCatalog | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}

/** Freshness policy for explicit picker reads. */
export interface ModelCatalogDirectoryOptions {
  /** Maximum age before opening a picker revalidates against the Host. */
  staleAfterMs?: number
  /** Monotonic-enough wall clock used only for catalog age. */
  now?: () => number
}

/** Read policy for one shared catalog request. */
export interface ModelCatalogLoadOptions {
  /** Re-enter the Host path when the current value has aged past the bound. */
  freshIfStale?: boolean
}

const DEFAULT_STALE_AFTER_MS = 30_000

/** Loads at most one model catalog for the current Host generation. */
export class ModelCatalogDirectory {
  /** Current shared catalog value and load lifecycle. */
  readonly store: SnapshotStore<ModelCatalogState> = createSnapshotStore({
    value: null,
    status: 'idle',
    error: null,
  })

  private generation = 0
  private inflight: Promise<ModelCatalog> | undefined
  private refreshQueued = false
  private loadedAt: number | undefined
  private readonly staleAfterMs: number
  private readonly now: () => number

  /**
   * @param ctx - the providing plugin's context, whose `remote.session`
   * namespace carries the Host-generation catalog.
   */
  constructor(
    private readonly ctx: ClientContext,
    options: ModelCatalogDirectoryOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Return the current generation's catalog, sharing its one in-flight load.
   * @param options - whether a loaded catalog should be revalidated once stale.
   * @returns the loaded global catalog.
   */
  load(options: ModelCatalogLoadOptions = {}): Promise<ModelCatalog> {
    const state = this.store.getSnapshot()
    const stale = this.loadedAt === undefined || this.now() - this.loadedAt > this.staleAfterMs
    if (state.status === 'ready' && state.value !== null
      && (options.freshIfStale !== true || !stale)) return Promise.resolve(state.value)
    if (this.inflight !== undefined) return this.inflight
    const generation = this.generation
    const lastGood = state.value
    this.store.update((draft) => {
      draft.status = 'loading'
      draft.error = null
    })
    const operation = this.ctx.remote.session.modelCatalog().then((response) => {
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      if (generation === this.generation) {
        this.loadedAt = this.now()
        this.store.set({ value: response.value, status: 'ready', error: null })
      }
      return response.value
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.store.update((draft) => {
          draft.status = 'error'
          draft.error = error instanceof Error ? error.message : String(error)
        })
      }
      if (lastGood !== null && options.freshIfStale === true) return lastGood
      throw error
    }).finally(() => {
      if (generation === this.generation && this.inflight === operation) {
        this.inflight = undefined
        if (this.refreshQueued) {
          this.refreshQueued = false
          void this.reload().catch(() => { /* the observable store owns refresh errors */ })
        }
      }
    })
    this.inflight = operation
    return operation
  }

  /**
   * Invalidate the loaded catalog; the next explicit menu read reloads it.
   * @param clear - whether values from the previous Host generation must be hidden.
   */
  private invalidate(clear = false): void {
    this.generation += 1
    this.inflight = undefined
    this.loadedAt = undefined
    const value = clear ? null : this.store.getSnapshot().value
    this.store.set({ value, status: 'idle', error: null })
  }

  /** Invalidate and reload the catalog after a Host-side model input changes. */
  refresh(): void {
    if (this.inflight !== undefined) {
      this.refreshQueued = true
      return
    }
    if (this.store.getSnapshot().status === 'loading') return
    void this.reload().catch(() => { /* the observable store owns refresh errors */ })
  }

  /**
   * Re-read the Host catalog immediately while retaining its last good value.
   * @returns the refreshed global catalog, or the shared in-flight refresh.
   */
  reload(): Promise<ModelCatalog> {
    if (this.inflight !== undefined) return this.inflight
    this.invalidate()
    return this.load({ freshIfStale: true })
  }

  /** Keep the catalog usable while an explicit provider refresh is running. */
  beginRefresh(): void {
    const state = this.store.getSnapshot()
    this.store.set({ ...state, status: 'loading', error: null })
  }

  /**
   * Surface a partial explicit-refresh failure without discarding catalog rows.
   * @param message - sanitized provider-local failures to expose beside retained rows.
   */
  reportRefreshFailure(message: string): void {
    const state = this.store.getSnapshot()
    this.store.set({ ...state, status: 'error', error: message })
  }

  /** Clear Host-specific values and load the replacement Host generation. */
  resetGeneration(): void {
    this.refreshQueued = false
    this.invalidate(true)
    void this.load().catch(() => { /* the selector exposes the shared error */ })
  }
}
