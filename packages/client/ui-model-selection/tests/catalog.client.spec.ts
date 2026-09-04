import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'

const catalog = (model: string): ModelCatalog => ({
  default: { provider: 'fixture', model },
  routableProviders: ['fixture'],
  groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: model, name: model }] }],
  failures: [],
})

function directory(
  models: () => Promise<unknown>,
  options?: ConstructorParameters<typeof ModelCatalogDirectory>[1],
): ModelCatalogDirectory {
  // The providing plugin's context, scripted down to the one method it calls.
  return new ModelCatalogDirectory({ remote: { session: { modelCatalog: models } } } as never, options)
}

describe('ModelCatalogDirectory', () => {
  it('shares one failing request, exposes the RPC error, and permits a retry', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: false, error: new RemoteError('gateway/internal', 'catalog offline', {}),
      })
      .mockResolvedValueOnce({ ok: true, value: catalog('recovered') })
    const subject = directory(models)

    const first = subject.load()
    expect(subject.load()).toBe(first)
    await expect(first).rejects.toThrow('gateway/internal: catalog offline')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'gateway/internal: catalog offline' })
    await expect(subject.load()).resolves.toEqual(catalog('recovered'))
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('does not publish a successful result from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.resolve({ ok: true, value: catalog('stale') })
    await expect(stale).resolves.toEqual(catalog('stale'))
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading' })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('does not publish a failure from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.reject(new Error('stale failure'))
    await expect(stale).rejects.toThrow('stale failure')
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading', error: null })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('contains refresh failures while retaining old data and clears it on a failed Host reset', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('old') })
      .mockRejectedValueOnce('refresh failed')
      .mockRejectedValueOnce(new Error('reset failed'))
    const subject = directory(models)
    await subject.load()

    subject.refresh()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: catalog('old'), status: 'error', error: 'refresh failed',
      })
    })

    subject.resetGeneration()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: null, status: 'error', error: 'reset failed',
      })
    })
  })

  it('contains direct and queued event refresh failures before any last-good catalog', async () => {
    const first = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('queued offline'))
    const subject = directory(models)

    const initial = subject.load()
    subject.refresh()
    first.reject(new Error('initial offline'))
    await expect(initial).rejects.toThrow('initial offline')
    await vi.waitFor(() => {
      expect(models).toHaveBeenCalledTimes(2)
      expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'queued offline' })
    })

    const direct = directory(vi.fn().mockRejectedValue(new Error('direct offline')))
    direct.refresh()
    await vi.waitFor(() => {
      expect(direct.store.getSnapshot()).toMatchObject({ status: 'error', error: 'direct offline' })
    })
  })

  it('revalidates a stale picker read once while keeping a fresh catalog local', async () => {
    let now = 0
    const next = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('old') })
      .mockReturnValueOnce(next.promise)
    const subject = directory(models, { staleAfterMs: 1_000, now: () => now })
    await subject.load()

    now = 999
    await subject.load({ freshIfStale: true })
    expect(models).toHaveBeenCalledTimes(1)

    now = 1_001
    const first = subject.load({ freshIfStale: true })
    const shared = subject.load({ freshIfStale: true })
    expect(shared).toBe(first)
    expect(subject.store.getSnapshot()).toMatchObject({
      value: catalog('old'), status: 'loading', error: null,
    })
    next.resolve({ ok: true, value: catalog('new') })
    await expect(first).resolves.toEqual(catalog('new'))
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('returns the last good catalog when stale revalidation fails', async () => {
    let now = 0
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('old') })
      .mockRejectedValueOnce(new Error('refresh offline'))
    const subject = directory(models, { staleAfterMs: 10, now: () => now })
    await subject.load()

    now = 11
    await expect(subject.load({ freshIfStale: true })).resolves.toEqual(catalog('old'))
    expect(subject.store.getSnapshot()).toEqual({
      value: catalog('old'), status: 'error', error: 'refresh offline',
    })
  })
})
