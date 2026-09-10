import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteFeedLifecycle } from '../src/client/feed-lifecycle.ts'

type Stream = { dispose(): Promise<void> }

class TestLifecycle extends RemoteFeedLifecycle<Stream> {
  setStream(stream: Stream): void { this.stream = stream }
  setTimer(timer: ReturnType<typeof setTimeout>): void { this.timer = timer }
  failWith(handler: (error: unknown) => void | Promise<void>): void { this.onCloseFailure = handler }
  closeStream(): void { this.close() }
  state(): { disposed: boolean; epoch: number; stream: Stream | undefined; timer: ReturnType<typeof setTimeout> | undefined } {
    return { disposed: this.disposed, epoch: this.epoch, stream: this.stream, timer: this.timer }
  }
}

afterEach(() => { vi.useRealTimers() })

describe('RemoteFeedLifecycle', () => {
  it('detaches streams once and waits for each predecessor before disposal', async () => {
    const lifecycle = new TestLifecycle()
    const firstClose = Promise.withResolvers<undefined>()
    const secondClose = Promise.withResolvers<undefined>()
    const first = { dispose: vi.fn(() => firstClose.promise) }
    const second = { dispose: vi.fn(() => secondClose.promise) }
    lifecycle.setStream(first)
    lifecycle.closeStream()
    lifecycle.closeStream()
    lifecycle.setStream(second)
    const stopped = vi.fn()
    const shuttingDown = lifecycle.dispose().then(stopped)
    expect(lifecycle.state()).toEqual({ disposed: true, epoch: 1, stream: undefined, timer: undefined })
    await Promise.resolve(undefined)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).not.toHaveBeenCalled()
    expect(stopped).not.toHaveBeenCalled()
    firstClose.resolve(undefined)
    await vi.waitFor(() => { expect(second.dispose).toHaveBeenCalledOnce() })
    expect(stopped).not.toHaveBeenCalled()
    secondClose.resolve(undefined)
    await shuttingDown
    await lifecycle.dispose()
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
  })

  it('cancels a retry even when no stream has opened', async () => {
    vi.useFakeTimers()
    const lifecycle = new TestLifecycle()
    const retry = vi.fn()
    lifecycle.setTimer(setTimeout(() => { retry() }, 1000))
    await lifecycle.dispose()
    await vi.runAllTimersAsync()
    expect(retry).not.toHaveBeenCalled()
    expect(lifecycle.state()).toEqual({ disposed: true, epoch: 1, stream: undefined, timer: undefined })
  })

  it('keeps teardown rejected without an owner handler', async () => {
    const failure = new Error('close failed')
    const lifecycle = new TestLifecycle()
    lifecycle.setStream({ dispose: async () => { throw failure } })
    await expect(lifecycle.dispose()).rejects.toBe(failure)
    await expect(lifecycle.dispose()).rejects.toBe(failure)
  })

  it('awaits owner failure handling and passes the original teardown error', async () => {
    const lifecycle = new TestLifecycle()
    const failure = new Error('close failed')
    const handling = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const onFailure = vi.fn(async () => {
      expect(lifecycle.state().disposed).toBe(true)
      entered.resolve(undefined)
      await handling.promise
    })
    lifecycle.failWith(onFailure)
    lifecycle.setStream({ dispose: async () => { throw failure } })
    const stopped = vi.fn()
    const shuttingDown = lifecycle.dispose().then(stopped)
    await entered.promise
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure)
    expect(stopped).not.toHaveBeenCalled()
    handling.resolve(undefined)
    await shuttingDown
    expect(stopped).toHaveBeenCalledOnce()
  })
})
