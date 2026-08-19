/**
 * Identity reuse for repeatedly derived read-only data.
 *
 * A derivation that rebuilds a whole session on every streaming chunk returns
 * content-identical values under fresh identities, which defeats every
 * downstream `useMemo`. These helpers fold a freshly built value onto the
 * previously published one: an equivalent member keeps the previous member's
 * identity, and a container whose members all matched is returned as the
 * previous container.
 *
 * Contract: the previous value must already be published as read-only. A
 * reused member stays referenced by the earlier publication, so no caller may
 * mutate a value that passed through these helpers. The fresh containers
 * handed in are adopted and rewritten in place.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Compare two derived values by content, descending through arrays and plain
 * objects. Any other object (Map, Set, class instance) compares by identity,
 * because a derivation that rebuilds one rebuilds its members too.
 */
function isEquivalent(next: unknown, previous: unknown): boolean {
  if (Object.is(next, previous)) return true
  if (Array.isArray(next)) {
    if (!Array.isArray(previous) || next.length !== previous.length) return false
    for (const [index, member] of next.entries()) {
      if (!isEquivalent(member, previous[index])) return false
    }
    return true
  }
  if (!isPlainObject(next) || !isPlainObject(previous)) return false
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(previous).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(previous, key)) return false
    if (!isEquivalent(next[key], previous[key])) return false
  }
  return true
}

/**
 * Keep the previous identity for an unchanged value.
 *
 * @param next - Freshly derived value.
 * @param previous - Value published by the previous derivation.
 * @returns The previous value when equivalent, otherwise the fresh one.
 */
export function reuseValue<T>(next: T, previous: T | undefined): T {
  return previous !== undefined && isEquivalent(next, previous) ? previous : next
}

/**
 * Rewrite every equivalent member of a freshly derived array to the previously
 * published member, so an appended element is the only new identity in it.
 *
 * @param next - Freshly derived array, adopted and rewritten in place.
 * @param previous - Array published by the previous derivation.
 * @returns The previous array when every member matched and the length is
 *   unchanged, otherwise the rewritten fresh array.
 */
export function reuseArray<T>(next: T[], previous: readonly T[] | undefined): readonly T[] {
  if (previous === undefined) return next
  let unchanged = next.length === previous.length
  const shared = Math.min(next.length, previous.length)
  for (let index = 0; index < shared; index++) {
    const candidate = previous[index] as T
    if (next[index] === candidate) continue
    if (isEquivalent(next[index], candidate)) next[index] = candidate
    else unchanged = false
  }
  return unchanged ? previous : next
}

/**
 * Rewrite every equivalent entry value of a freshly derived map to the
 * previously published value.
 *
 * @param next - Freshly derived map, adopted and rewritten in place.
 * @param previous - Map published by the previous derivation.
 * @returns The previous map when every entry matched and the size is
 *   unchanged, otherwise the rewritten fresh map.
 */
export function reuseMap<K, V>(
  next: Map<K, V>,
  previous: ReadonlyMap<K, V> | undefined,
): ReadonlyMap<K, V> {
  if (previous === undefined) return next
  let unchanged = next.size === previous.size
  for (const [key, value] of next) {
    if (!previous.has(key)) {
      unchanged = false
      continue
    }
    const candidate = previous.get(key) as V
    if (value === candidate) continue
    if (isEquivalent(value, candidate)) next.set(key, candidate)
    else unchanged = false
  }
  return unchanged ? previous : next
}
