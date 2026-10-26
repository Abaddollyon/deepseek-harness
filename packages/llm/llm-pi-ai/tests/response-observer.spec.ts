import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderResponseObserver } from '../src/response-observer.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub the global `fetch` so each call waits until the test answers it. */
function pendingFetches() {
  const calls: { readonly url: string; readonly answer: (response: Response | Error) => void }[] = []
  vi.stubGlobal('fetch', (input: string | URL | Request) => new Promise<Response>((resolve, reject) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      answer: (response) => {
        if (response instanceof Error) reject(response)
        else resolve(response)
      },
    })
  }))
  return calls
}

describe('ProviderResponseObserver', () => {
  it('attributes each response to the request whose work fetched it while requests interleave', async () => {
    const calls = pendingFetches()
    const observer = new ProviderResponseObserver()
    const first = observer.observe(() => observer.fetch('https://pool.test/v1/messages'))
    const second = observer.observe(() => observer.fetch('https://pool.test/v1/messages'))

    calls[1]?.answer(new Response('{}', { status: 503 }))
    await second.result
    calls[0]?.answer(new Response('{}', { status: 429, headers: { 'retry-after': '3' } }))
    await first.result

    expect(first.lastResponse()).toEqual({ status: 429, retryAfterMs: 3_000 })
    expect(second.lastResponse()).toEqual({ status: 503 })
  })

  it('forgets an earlier attempt\'s response once a later attempt of the same request starts', async () => {
    const calls = pendingFetches()
    const observer = new ProviderResponseObserver()
    let afterFirstAttempt: unknown
    const request = observer.observe(async () => {
      const limited = observer.fetch('https://pool.test/chat/completions')
      calls[0]?.answer(new Response('{}', { status: 429, headers: { 'retry-after': '3' } }))
      await limited
      afterFirstAttempt = request.lastResponse()
      return await observer.fetch('https://pool.test/chat/completions')
    })
    await vi.waitFor(() => { expect(calls).toHaveLength(2) })
    expect(afterFirstAttempt).toEqual({ status: 429, retryAfterMs: 3_000 })
    expect(request.lastResponse()).toBeUndefined()

    calls[1]?.answer(new Error('other side closed'))
    await expect(request.result).rejects.toThrow('other side closed')
    expect(request.lastResponse()).toBeUndefined()
  })

  it('passes credential exchanges and requests outside any observation through unrecorded', async () => {
    const calls = pendingFetches()
    const observer = new ProviderResponseObserver()
    const request = observer.observe(async () => {
      const model = observer.fetch(new URL('https://pool.test/v1/messages'))
      calls[0]?.answer(new Response('{}', { status: 429 }))
      await model
      const exchanges = [
        observer.fetch('https://pool.test/v1/oauth/token'),
        observer.fetch(new URL('https://pool.test/v1/oauth/token#refresh')),
        observer.fetch(new Request('https://pool.test/v1/oauth/token?grant=jwt', { method: 'POST' })),
      ]
      for (const call of calls.slice(1)) call.answer(new Response('{}', { status: 503, headers: { 'retry-after': '9' } }))
      return await Promise.all(exchanges)
    })

    expect((await request.result).map(response => response.status)).toEqual([503, 503, 503])
    expect(request.lastResponse()).toEqual({ status: 429 })
    const unobserved = observer.fetch(new Request('https://pool.test/v1/messages'))
    calls[4]?.answer(new Response('{}', { status: 500 }))
    expect((await unobserved).status).toBe(500)
    expect(calls.map(call => call.url)).toEqual([
      'https://pool.test/v1/messages',
      'https://pool.test/v1/oauth/token',
      'https://pool.test/v1/oauth/token#refresh',
      'https://pool.test/v1/oauth/token?grant=jwt',
      'https://pool.test/v1/messages',
    ])
  })
})
