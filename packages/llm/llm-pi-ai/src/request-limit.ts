/**
 * First-in, first-out admission of concurrent model requests per provider route.
 *
 * @module dsh-llm-pi-ai/request-limit
 */

interface QueuedRequest {
  readonly admit: () => void
}

interface RouteQueue {
  active: number
  limit: number
  readonly waiting: QueuedRequest[]
}

/**
 * Admits each route's requests up to its current limit and queues the rest in
 * arrival order. A route's limit is the one its most recent request carried,
 * so raising or removing it admits queued requests immediately, while lowering
 * it lets requests already admitted finish.
 */
export class RouteRequestLimiter {
  private readonly routes = new Map<string, RouteQueue>()

  /**
   * Wait for one request slot on a route.
   * @param route - provider route key.
   * @param limit - the route's configured concurrent-request limit; `undefined` means unlimited.
   * @param signal - the caller's cancellation. A request that would queue
   *   after `signal` aborted, or whose `signal` aborts while it waits, leaves
   *   the queue without a slot so the caller's own abort handling ends it.
   * @returns the admitted slot, released once on disposal, or an empty slot after an abort.
   */
  async acquire(route: string, limit: number | undefined, signal: AbortSignal | undefined): Promise<Disposable> {
    const queue = this.routes.get(route) ?? { active: 0, limit: Number.POSITIVE_INFINITY, waiting: [] }
    this.routes.set(route, queue)
    queue.limit = limit ?? Number.POSITIVE_INFINITY
    this.admitWaiting(queue)
    if (queue.waiting.length === 0 && queue.active < queue.limit) {
      queue.active += 1
      return this.releaser(route, queue)
    }
    if (signal?.aborted === true) return NO_SLOT
    const admitted = Promise.withResolvers<boolean>()
    let detach = (): void => {}
    const request: QueuedRequest = {
      admit: () => {
        detach()
        admitted.resolve(true)
      },
    }
    if (signal !== undefined) {
      const onAbort = (): void => {
        queue.waiting.splice(queue.waiting.indexOf(request), 1)
        admitted.resolve(false)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      detach = () => { signal.removeEventListener('abort', onAbort) }
    }
    queue.waiting.push(request)
    return await admitted.promise ? this.releaser(route, queue) : NO_SLOT
  }

  private releaser(route: string, queue: RouteQueue): Disposable {
    let released = false
    return {
      [Symbol.dispose]: () => {
        if (released) return
        released = true
        queue.active -= 1
        this.admitWaiting(queue)
        if (queue.active === 0 && queue.waiting.length === 0) this.routes.delete(route)
      },
    }
  }

  private admitWaiting(queue: RouteQueue): void {
    while (queue.active < queue.limit) {
      const next = queue.waiting.shift()
      if (next === undefined) return
      queue.active += 1
      next.admit()
    }
  }
}

const NO_SLOT: Disposable = Object.freeze({ [Symbol.dispose]: () => {} })
