import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { SessionFeedRecovery } from '../src/client/feed.ts'
import { FakeApiClient, deferred, fakeRemote } from './fake-api.client.ts'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'

const unavailable = () => new RemoteError('gateway/service-unavailable', 'Session service is starting', {
  endpoint: 'session/control',
})
const feeds: SessionFeedRecovery[] = []

afterEach(async () => {
  await Promise.all(feeds.splice(0).map(feed => feed.dispose()))
  vi.useRealTimers()
})

async function flush(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve()
}

function fixture(refresh = vi.fn<() => Promise<RemoteFailure | null>>(async () => null)) {
  const api = new FakeApiClient()
  const remote = fakeRemote(api)
  const accept = vi.fn()
  const open = vi.spyOn(remote.session, 'control')
  const feed = new SessionFeedRecovery(remote, [10, 20], accept, refresh)
  feeds.push(feed)
  return { feed, api, remote, accept, refresh, open }
}

describe('Session feed recovery', () => {
  it('recovers initial typed service absence without a page reload and waits for the list', async () => {
    vi.useFakeTimers()
    const pending = deferred<RemoteFailure | null>()
    const bench = fixture(vi.fn(() => pending.promise))
    bench.open.mockImplementationOnce(async function* () { throw unavailable() })
    bench.feed.retry()
    await flush()
    expect(bench.feed.snapshot.getSnapshot()).toMatchObject({ state: 'retrying', attempt: 1 })
    expect(bench.refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(bench.open).toHaveBeenCalledTimes(2)
    expect(bench.accept).toHaveBeenCalledOnce()
    expect(bench.feed.snapshot.getSnapshot().state).toBe('retrying')
    pending.resolve(null)
    await flush()
    expect(bench.feed.snapshot.getSnapshot()).toEqual({ state: 'ready', error: null, attempt: 0 })
  })

  it('bounds repeated unavailable responses and manual retry starts a fresh budget', async () => {
    vi.useFakeTimers()
    const bench = fixture()
    bench.open.mockImplementation(async function* () { throw unavailable() })
    bench.feed.retry()
    await vi.advanceTimersByTimeAsync(100)
    expect(bench.open).toHaveBeenCalledTimes(3)
    expect(bench.feed.snapshot.getSnapshot()).toMatchObject({ state: 'error', attempt: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(bench.open).toHaveBeenCalledTimes(3)
    bench.open.mockRestore()
    bench.feed.retry()
    await flush()
    expect(bench.feed.snapshot.getSnapshot().state).toBe('ready')
  })

  it('retries temporary list failure after a control baseline', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn<() => Promise<RemoteFailure | null>>()
      .mockResolvedValueOnce(unavailable()).mockResolvedValue(null)
    const bench = fixture(refresh)
    bench.feed.retry()
    await vi.advanceTimersByTimeAsync(10)
    expect(bench.refresh).toHaveBeenCalledTimes(2)
    expect(bench.feed.snapshot.getSnapshot().state).toBe('ready')
  })

  it.each(['gateway/bad-request', 'gateway/internal'] as const)(
    'surfaces %s without automatic retry', async (code) => {
      vi.useFakeTimers()
      const bench = fixture()
      bench.open.mockImplementation(async function* () { throw new RemoteError(code, 'Refused', {}) })
      bench.feed.retry()
      await vi.advanceTimersByTimeAsync(1000)
      expect(bench.open).toHaveBeenCalledOnce()
      expect(bench.feed.snapshot.getSnapshot()).toMatchObject({ state: 'error', error: { code } })
    },
  )

  it('keeps accepted rows stale during a failed replacement and discards its late list completion', async () => {
    vi.useFakeTimers()
    const bench = fixture()
    bench.feed.retry()
    await flush()
    expect(bench.feed.snapshot.getSnapshot().state).toBe('ready')
    const pending = deferred<RemoteFailure | null>()
    bench.refresh.mockImplementationOnce(() => pending.promise)
    bench.feed.retry()
    await flush()
    bench.api.failStreams(new RemoteError('gateway/internal', 'Invalid protocol', {}))
    await flush()
    expect(bench.feed.snapshot.getSnapshot()).toMatchObject({ state: 'stale', error: { message: 'Invalid protocol' } })
    pending.resolve(null)
    await flush()
    expect(bench.feed.snapshot.getSnapshot()).toMatchObject({ state: 'stale', error: { message: 'Invalid protocol' } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(bench.open).toHaveBeenCalledTimes(2)
  })

  it('marks carrier recovery stale until the replacement list arrives', async () => {
    const bench = fixture()
    bench.feed.retry()
    await flush()
    const pending = deferred<RemoteFailure | null>()
    bench.refresh.mockImplementationOnce(() => pending.promise)
    bench.api.failStreams(new RemoteStreamCarrierError('Disconnected'))
    await flush()
    expect(bench.feed.snapshot.getSnapshot().state).toBe('stale')
    pending.resolve(null)
    await flush()
    expect(bench.feed.snapshot.getSnapshot().state).toBe('ready')
  })

  it('ignores a rejected list from the preceding carrier baseline', async () => {
    const first = deferred<RemoteFailure | null>()
    const second = deferred<RemoteFailure | null>()
    const refresh = vi.fn<() => Promise<RemoteFailure | null>>()
      .mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const bench = fixture(refresh)
    bench.feed.retry()
    await flush()
    bench.api.failStreams(new RemoteStreamCarrierError('Replaced'))
    await flush()
    first.reject(new RemoteError('gateway/internal', 'Old generation failed', {}))
    await flush()
    expect(bench.feed.snapshot.getSnapshot().state).toBe('loading')
    second.resolve(null)
    await flush()
    expect(bench.feed.snapshot.getSnapshot().state).toBe('ready')
  })

  it('disposes pending retry timers and fences late completion and explicit retries', async () => {
    vi.useFakeTimers()
    const bench = fixture()
    bench.open.mockImplementation(async function* () { throw unavailable() })
    bench.feed.retry()
    await flush()
    await bench.feed.dispose()
    const observed = bench.feed.snapshot.getSnapshot()
    bench.feed.retry()
    await vi.advanceTimersByTimeAsync(1000)
    expect(bench.open).toHaveBeenCalledOnce()
    expect(bench.feed.snapshot.getSnapshot()).toBe(observed)
  })

  it.each([new Error('List unavailable'), 'List unavailable'])(
    'publishes an untyped list rejection as a terminal feed failure: %s', async (failure) => {
      const bench = fixture(vi.fn<() => Promise<RemoteFailure | null>>().mockRejectedValue(failure))
      bench.feed.retry()
      await flush()
      expect(bench.feed.snapshot.getSnapshot()).toMatchObject({
        state: 'error', attempt: 0,
        error: { code: 'gateway/internal', message: 'List unavailable' },
      })
      expect(bench.open).toHaveBeenCalledOnce()
    },
  )

  it('ignores a rejected list after its owner has disposed', async () => {
    const pending = deferred<RemoteFailure | null>()
    const bench = fixture(vi.fn(() => pending.promise))
    bench.feed.retry()
    await flush()
    await bench.feed.dispose()
    const observed = bench.feed.snapshot.getSnapshot()
    pending.reject(new Error('Late list failure'))
    await flush()
    expect(bench.feed.snapshot.getSnapshot()).toBe(observed)
  })

  it('accepts control increments without repeating the authoritative list read', async () => {
    const bench = fixture()
    bench.feed.retry()
    await flush()
    const update = { type: 'queue' as const, sessionId: 'control-increment' as never, items: [] }
    bench.api.pushControl(update)
    await flush()
    expect(bench.accept).toHaveBeenLastCalledWith(update)
    expect(bench.refresh).toHaveBeenCalledOnce()
    expect(bench.feed.snapshot.getSnapshot().state).toBe('ready')
  })

  it('ignores a list completing after disposal', async () => {
    const pending = deferred<RemoteFailure | null>()
    const bench = fixture(vi.fn(() => pending.promise))
    bench.feed.retry()
    await flush()
    await bench.feed.dispose()
    const observed = bench.feed.snapshot.getSnapshot()
    pending.resolve(null)
    await flush()
    expect(bench.feed.snapshot.getSnapshot()).toBe(observed)
  })

  it('ignores carrier loss admitted before its owner is replaced', async () => {
    const bench = fixture()
    bench.open.mockImplementationOnce(async function* () {
      queueMicrotask(() => { bench.feed.retry() })
      throw new RemoteStreamCarrierError('Previous owner disconnected')
    })
    bench.feed.retry()
    await flush()
    expect(bench.open).toHaveBeenCalledTimes(2)
    expect(bench.feed.snapshot.getSnapshot()).toEqual({ state: 'ready', error: null, attempt: 0 })
  })

  it('coalesces replacement requests while the previous iterator closes', async () => {
    const bench = fixture()
    bench.feed.retry()
    await flush()
    bench.feed.retry()
    bench.feed.retry()
    bench.feed.retry()
    await flush()
    expect(bench.open).toHaveBeenCalledTimes(2)
    expect(bench.feed.snapshot.getSnapshot().state).toBe('ready')
  })
})
