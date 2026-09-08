/** Feature presentation offsets belong to the native host/session store identity. */
const positions = new WeakMap<object, Map<string, number>>()

/**
 * Attach only while a feature is active. Chat retains its own anchor/follow policy.
 * @param area - Current feature outlet within the resident conversation shell.
 * @param scope - Native Host/Session presentation store identity.
 * @param view - Feature view key within that scope.
 * @returns Disposer for scroll observation and pending restoration.
 */
export function bindFeatureScroll(area: HTMLElement, scope: object, view: string): () => void {
  const saved = positions.get(scope) ?? new Map<string, number>()
  positions.set(scope, saved)
  const desired = saved.get(view) ?? 0
  let restoring = desired > 0
  const owner = (): HTMLElement => area.querySelector<HTMLElement>('[data-feature-scroll]') ?? area
  const restore = (): void => {
    const target = owner()
    if (target !== area) area.scrollTop = 0
    target.scrollTop = desired
    if (Math.abs(target.scrollTop - desired) < 1) restoring = false
  }
  // The resident shell is a clipping frame in feature mode. Reset only on
  // entry; a Chat mount will restore its own saved anchor when it returns.
  const shell = area.closest<HTMLElement>('[data-conversation-scroll]')
  if (shell !== null) shell.scrollTop = 0
  restore()
  const observer = new MutationObserver(() => { if (restoring) restore() })
  observer.observe(area, { childList: true, subtree: true })
  const stopRestoring = (): void => { restoring = false }
  const onScroll = (event: Event): void => {
    if (event.target !== owner() || restoring) return
    saved.set(view, owner().scrollTop)
    if (saved.size > 32) {
      const oldest = saved.keys().next().value
      if (oldest !== undefined) saved.delete(oldest)
    }
  }
  // Explicit reader movement wins over an offset awaiting asynchronous rows.
  area.addEventListener('wheel', stopRestoring, { passive: true })
  area.addEventListener('pointerdown', stopRestoring)
  area.addEventListener('keydown', stopRestoring)
  area.addEventListener('scroll', onScroll, true)
  return () => {
    observer.disconnect()
    area.removeEventListener('wheel', stopRestoring)
    area.removeEventListener('pointerdown', stopRestoring)
    area.removeEventListener('keydown', stopRestoring)
    area.removeEventListener('scroll', onScroll, true)
  }
}
