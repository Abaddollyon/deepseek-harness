/**
 * A least-recently-used map whose bound is read at write time from a caller
 * supplied thunk, so a deployment may retune the bound without rebuilding the
 * cache. Used for pure render products (highlighted source, settled Markdown
 * element trees) whose recomputation is the cost being avoided; it holds no
 * business state and observes nothing, so it is not a store.
 */

/** Retention policy: most-recently used entries survive, oldest evict first. */
export class BoundedCache<V> {
  private readonly entries = new Map<string, V>()

  /** @param limit - reads the live maximum entry count on each write. */
  constructor(private readonly limit: () => number) {}

  /**
   * Look one entry up, refreshing its position in the eviction order.
   * @param key - cache key.
   * @returns the retained value, or undefined on a miss.
   */
  get(key: string): V | undefined {
    const hit = this.entries.get(key)
    if (hit === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  /**
   * Retain `value`, evicting least-recently-used entries down to the live bound.
   * @param key - cache key.
   * @param value - value to retain.
   */
  set(key: string, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    const limit = this.limit()
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= limit) break
      this.entries.delete(oldest)
    }
  }

  /** Drop every retained entry. */
  clear(): void {
    this.entries.clear()
  }

  /**
   * The live occupancy, for callers asserting the bound holds.
   * @returns the retained entry count.
   */
  get size(): number {
    return this.entries.size
  }
}

/**
 * Stable per-object cache-key fragments. A render cache keyed on a caller
 * supplied object (localized labels, a session's file-mention resolver) must
 * key on that object's IDENTITY, because the elements it produced captured
 * that object's callbacks. Ids are minted lazily and held weakly, so a dead
 * session's resolver neither pins memory nor collides with a later one.
 */
export class IdentityKeys {
  private readonly ids = new WeakMap<object, number>()
  private next = 0

  /**
   * Name one object for use inside a cache key.
   * @param value - the identity to name, or undefined for the absent case.
   * @returns a key fragment that is stable for this object and unique across objects.
   */
  keyFor(value: object | undefined): string {
    if (value === undefined) return '-'
    let id = this.ids.get(value)
    if (id === undefined) {
      this.next += 1
      id = this.next
      this.ids.set(value, id)
    }
    return String(id)
  }
}
