import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime, {
  WebError,
  type WebFetchProvider,
  type WebFetchResult,
  type WebSearchBatchOutcome,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from '@deepseek-ai/dsh-web'

/** A scripted search provider for contract tests. */
function makeSearchProvider(
  id: string,
  available: boolean,
  search: (request: WebSearchRequest) => Promise<WebSearchResult>,
): WebSearchProvider {
  return { id, available: () => available, search: request => search(request) }
}

function makeFetchProvider(id: string, available: boolean, result: WebFetchResult): WebFetchProvider {
  return { id, available: () => available, fetch: () => Promise.resolve(result) }
}

const available = true
const unavailable = false

function searchResult(marker: string, overrides: Partial<WebSearchResult> = {}): WebSearchResult {
  return { content: marker, sources: [], truncated: false, ...overrides }
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function fetchResult(marker: string): WebFetchResult {
  return { url: 'https://example.com', statusCode: 200, body: { kind: 'text', content: marker }, truncated: false }
}

/** Mount a WebRuntime on a fresh root context with the given config. */
async function mountWeb(config: ConstructorParameters<typeof WebRuntime>[1] = {}): Promise<{
  ctx: Context
  web: WebRuntime
  fiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  const fiber = await ctx.plugin(WebRuntime, config)
  return { ctx, web: ctx.web, fiber }
}

describe('WebRuntime registration', () => {
  it('registers a search provider and unregisters it via the returned disposer', async () => {
    const { web } = await mountWeb()

    const dispose = web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })

    dispose()
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws WEB_DUPLICATE_PROVIDER on a duplicate search id', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    expect(() => web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa')))))
      .toThrow(expect.objectContaining({ code: 'WEB_DUPLICATE_PROVIDER' }))
  })

  it('keeps search and fetch id namespaces independent', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('shared', available, () => Promise.resolve(searchResult('shared'))))
    expect(() => web.registerFetchProvider(makeFetchProvider('shared', available, fetchResult('shared')))).not.toThrow()
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, web } = await mountWeb()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    }, { inject: ['web'] }))
    await expect(web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })
    await fiber.dispose()
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })
})

describe('WebRuntime execution resolution', () => {
  it('throws WEB_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { web } = await mountWeb()
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws WEB_PROVIDER_UNAVAILABLE when providers exist but none are usable', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('throws WEB_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { web } = await mountWeb({ searchProvider: 'perplexity' })
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('throws WEB_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { web } = await mountWeb({ searchProvider: 'exa' })
    web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('throws WEB_PROVIDER_AMBIGUOUS rather than picking by order', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    await expect(web.search({ query: 'q' })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_AMBIGUOUS' }))
  })

  it('runs the configured provider even when another usable provider is registered', async () => {
    const { web } = await mountWeb({ searchProvider: 'perplexity' })
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    await expect(web.search({ query: 'q' })).resolves.toMatchObject({ content: 'perplexity' })
  })

  it('ignores unusable providers when auto-selecting', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    web.registerSearchProvider(makeSearchProvider('perplexity', unavailable, () => Promise.resolve(searchResult('perplexity'))))
    await expect(web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })
  })

  it('does not let registration order change auto-selection', async () => {
    const a = await mountWeb()
    a.web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    a.web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    await expect(a.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'perplexity' })

    const b = await mountWeb()
    b.web.registerSearchProvider(makeSearchProvider('perplexity', available, () => Promise.resolve(searchResult('perplexity'))))
    b.web.registerSearchProvider(makeSearchProvider('exa', unavailable, () => Promise.resolve(searchResult('exa'))))
    await expect(b.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'perplexity' })
  })

  it('runs the selected provider and returns its result', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(
      searchResult('exa', { content: 'answer', sources: [{ url: 'https://a' }] }),
    )))
    const result = await web.search({ query: 'q' })
    expect(result.content).toBe('answer')
    expect(result.sources).toEqual([{ url: 'https://a' }])
  })

  it('links caller cancellation through a coordinator-owned provider signal', async () => {
    const { web } = await mountWeb()
    const seen: (AbortSignal | undefined)[] = []
    web.registerSearchProvider({
      id: 'exa',
      available: () => available,
      search: (_request, signal) => { seen.push(signal); return Promise.resolve(searchResult('exa')) },
    })
    const controller = new AbortController()
    await web.search({ query: 'q' }, controller.signal)
    expect(seen[0]).toBeDefined()
    expect(seen[0]).not.toBe(controller.signal)
  })
})

describe('WebRuntime maxResults enforcement', () => {
  it('truncates sources and sets truncated when a provider over-returns', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa', {
      sources: [{ url: 'https://1' }, { url: 'https://2' }, { url: 'https://3' }],
    }))))
    const result = await web.search({ query: 'q', maxResults: 2 })
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('leaves truncated false when within the bound', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa', {
      sources: [{ url: 'https://1' }],
    }))))
    const result = await web.search({ query: 'q', maxResults: 8 })
    expect(result.sources).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  it('does not bound when maxResults is omitted', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa', {
      sources: [{ url: 'https://1' }, { url: 'https://2' }],
    }))))
    const result = await web.search({ query: 'q' })
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })
})

describe('WebRuntime batch search', () => {
  it('selects once and calls a native batch provider once in input order', async () => {
    const { web } = await mountWeb({ searchProvider: 'batch' })
    let availabilityChecks = 0
    let batchCalls = 0
    const provider: WebSearchProvider = {
      id: 'batch',
      available: async () => { availabilityChecks += 1; return true },
      search: () => Promise.reject(new Error('single search must not run')),
      searchMany: (request) => {
        batchCalls += 1
        return Promise.resolve(request.queries.map(query => ({
          query,
          result: {
            content: query,
            sources: [
              { url: `HTTP://EXAMPLE.COM:80/${query}#fragment` },
              { url: `http://example.com/${query}` },
              { url: 'file:///etc/passwd' },
            ],
            truncated: false,
          },
        })))
      },
    }
    web.registerSearchProvider(provider)

    const outcomes = await web.searchMany({ queries: ['one', 'two'], maxResults: 3 })

    expect(availabilityChecks).toBe(1)
    expect(batchCalls).toBe(1)
    expect(outcomes.map(outcome => outcome.query)).toEqual(['one', 'two'])
    expect(outcomes[0]?.result).toEqual({
      content: 'one',
      sources: [{ url: 'http://example.com/one' }],
      truncated: false,
    })
  })

  it('canonicalizes root URLs before deduplicating them', async () => {
    const { web } = await mountWeb({ searchProvider: 'roots' })
    web.registerSearchProvider(makeSearchProvider('roots', true, () => Promise.resolve({
      sources: [
        { url: 'https://example.com' },
        { url: 'https://example.com/' },
        { url: 'https://example.com#fragment' },
      ],
      truncated: false,
    })))

    await expect(web.search({ query: 'roots' })).resolves.toEqual({
      sources: [{ url: 'https://example.com' }],
      truncated: false,
    })
  })

  it('uses bounded legacy fan-out and preserves partial failures', async () => {
    const { web } = await mountWeb({ searchProvider: 'legacy', legacySearchConcurrency: 2 })
    let active = 0
    let maxActive = 0
    const provider: WebSearchProvider = {
      id: 'legacy',
      available: () => true,
      search: async ({ query }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        if (query === 'two') throw new WebError('safe upstream failure', 'WEB_UPSTREAM')
        return searchResult(query, { sources: [{ url: `https://${query}.test` }] })
      },
    }
    web.registerSearchProvider(provider)

    const outcomes = await web.searchMany({ queries: ['one', 'two', 'three', 'four'] })

    expect(maxActive).toBe(2)
    expect(outcomes).toEqual([
      { query: 'one', result: searchResult('one', { sources: [{ url: 'https://one.test' }] }) },
      { query: 'two', error: { code: 'WEB_UPSTREAM', message: 'safe upstream failure' } },
      { query: 'three', result: searchResult('three', { sources: [{ url: 'https://three.test' }] }) },
      { query: 'four', result: searchResult('four', { sources: [{ url: 'https://four.test' }] }) },
    ])
  })

  it('sanitizes legacy failures and passes only legacy request fields', async () => {
    const { web } = await mountWeb({ searchProvider: 'legacy' })
    const requests: WebSearchRequest[] = []
    web.registerSearchProvider({
      id: 'legacy',
      available: () => true,
      search: (request) => {
        requests.push(request)
        if (request.query === 'private') throw new Error('credential-shaped private detail')
        if (request.query === 'private-web-error') {
          throw new WebError('private provider WebError detail', 'WEB_PROVIDER_ERROR')
        }
        return Promise.resolve(searchResult(request.query))
      },
    })

    const outcomes = await web.searchMany({
      queries: ['private', 'private-web-error', 'public'],
      maxResults: 2,
      mode: 'live',
      allowedDomains: ['example.com'],
      blockedDomains: ['blocked.test'],
      location: { country: 'US' },
    })

    expect(requests).toEqual([
      { query: 'private', maxResults: 2 },
      { query: 'private-web-error', maxResults: 2 },
      { query: 'public', maxResults: 2 },
    ])
    expect(outcomes.slice(0, 2)).toEqual([
      { query: 'private', error: { code: 'WEB_PROVIDER_ERROR', message: 'web search provider failed' } },
      { query: 'private-web-error', error: { code: 'WEB_PROVIDER_ERROR', message: 'web search provider failed' } },
    ])
  })

  it('turns malformed native outcome mappings into protocol failures', async () => {
    const { web } = await mountWeb({ searchProvider: 'batch' })
    web.registerSearchProvider({
      id: 'batch',
      available: () => true,
      search: () => Promise.resolve(searchResult('unused')),
      searchMany: () => Promise.resolve([
        { query: 'wrong', result: searchResult('wrong') },
        {
          query: 'two',
          result: searchResult('two'),
          error: { code: 'WEB_BOTH', message: 'invalid both' },
        },
      ]),
    })

    await expect(web.searchMany({ queries: ['one', 'two', 'three'] })).resolves.toEqual([
      {
        query: 'one',
        error: { code: 'WEB_PROVIDER_PROTOCOL', message: 'web search provider returned an invalid batch outcome' },
      },
      {
        query: 'two',
        error: { code: 'WEB_PROVIDER_PROTOCOL', message: 'web search provider returned an invalid batch outcome' },
      },
      {
        query: 'three',
        error: { code: 'WEB_PROVIDER_PROTOCOL', message: 'web search provider returned an invalid batch outcome' },
      },
    ])
  })

  it('waits for every started legacy search to settle before rejecting cancellation', async () => {
    const { web } = await mountWeb({ searchProvider: 'legacy', legacySearchConcurrency: 2 })
    const controller = new AbortController()
    const releases: (() => void)[] = []
    let started = 0
    let settled = 0
    let notifyStarted: (() => void) | undefined
    const bothStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    web.registerSearchProvider({
      id: 'legacy',
      available: () => true,
      search: (_request, signal) => new Promise((resolve) => {
        started += 1
        if (started === 2) notifyStarted?.()
        signal?.addEventListener('abort', () => {}, { once: true })
        releases.push(() => {
          settled += 1
          resolve(searchResult('settled'))
        })
      }),
    })

    const pending = web.searchMany({ queries: ['one', 'two', 'three'] }, controller.signal)
    await bothStarted
    controller.abort(new Error('caller cancelled'))
    let rejected = false
    void pending.catch(() => { rejected = true })
    await Promise.resolve()
    expect(rejected).toBe(false)
    releases.forEach((release) => { release() })
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(settled).toBe(2)
    expect(started).toBe(2)
  })

  it.each([0, -1, 1.5])('rejects invalid direct legacy concurrency %s', (value) => {
    expect(() => new WebRuntime(new Context(), { legacySearchConcurrency: value })).toThrow(
      expect.objectContaining({ code: 'WEB_INVALID_CONFIG' }),
    )
  })

  it.each([
    ['searchCacheTtlMs', -1],
    ['searchCacheTtlMs', 1.5],
    ['liveSearchCacheTtlMs', -1],
    ['searchCacheMaxEntries', 0],
    ['nativeBatchConcurrency', 0],
    ['nativeBatchConcurrency', 3],
  ] as const)('rejects invalid direct coordinator config %s=%s', (name, value) => {
    const config = { [name]: value } as ConstructorParameters<typeof WebRuntime>[1]
    expect(() => new WebRuntime(new Context(), config)).toThrow(
      expect.objectContaining({ code: 'WEB_INVALID_CONFIG' }),
    )
  })

  it('normalizes thrown native failures without exposing unknown messages', async () => {
    const { web } = await mountWeb({ searchProvider: 'batch' })
    web.registerSearchProvider({
      id: 'batch',
      available: () => true,
      search: () => Promise.reject(new Error('unused')),
      searchMany: () => Promise.reject(new Error('credential-shaped private detail')),
    })

    await expect(web.searchMany({ queries: ['one', 'two'] })).resolves.toEqual([
      { query: 'one', error: { code: 'WEB_PROVIDER_ERROR', message: 'web search provider failed' } },
      { query: 'two', error: { code: 'WEB_PROVIDER_ERROR', message: 'web search provider failed' } },
    ])
  })

  it('rejects caller cancellation before provider selection', async () => {
    const { web } = await mountWeb({ searchProvider: 'batch' })
    let checked = false
    web.registerSearchProvider({
      id: 'batch',
      available: () => { checked = true; return true },
      search: () => Promise.resolve(searchResult('unused')),
    })
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))

    await expect(web.searchMany({ queries: ['one'] }, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_ABORTED' }),
    )
    expect(checked).toBe(false)
  })
})

describe('WebRuntime search coordination', () => {
  it('reuses cached query results and sends only partial misses in a later native batch', async () => {
    const { web } = await mountWeb({ searchProvider: 'native' })
    const requests: string[][] = []
    web.registerSearchProvider({
      id: 'native',
      available: () => true,
      search: () => Promise.reject(new Error('single search must not run')),
      searchMany: (request) => {
        requests.push([...request.queries])
        const call = requests.length
        return Promise.resolve(request.queries.map(query => ({
          query,
          result: searchResult(`call-${call}-${query}`),
        })))
      },
    })

    await web.searchMany({ queries: ['one', 'two'] })
    const outcomes = await web.searchMany({ queries: ['two', 'three'] })

    expect(requests).toEqual([['one', 'two'], ['three']])
    expect(outcomes.map(outcome => outcome.result?.content)).toEqual(['call-1-two', 'call-2-three'])
  })

  it('keys cache entries by normalized controls and does not cache live searches by default', async () => {
    const { web } = await mountWeb({ searchProvider: 'native' })
    let calls = 0
    web.registerSearchProvider({
      id: 'native',
      available: () => true,
      search: () => Promise.reject(new Error('single search must not run')),
      searchMany: (request) => {
        calls += 1
        return Promise.resolve(request.queries.map(query => ({ query, result: searchResult(String(calls)) })))
      },
    })
    const base = {
      queries: ['q'], mode: 'cached' as const, maxResults: 1,
      allowedDomains: ['A.test', 'b.test'], location: { country: 'US' },
    }
    await web.searchMany(base)
    await web.searchMany({ ...base, allowedDomains: ['B.TEST', 'a.test'] })
    await web.searchMany({ ...base, maxResults: 2 })
    await web.searchMany({ ...base, location: { country: 'CA' } })
    await web.searchMany({ queries: ['q'], mode: 'live' })
    await web.searchMany({ queries: ['q'], mode: 'live' })
    expect(calls).toBe(5)
  })

  it('expires cached results, evicts the least-recently-used entry, and never caches failures', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const { web } = await mountWeb({
        searchProvider: 'native', searchCacheTtlMs: 10, searchCacheMaxEntries: 2,
      })
      const calls = new Map<string, number>()
      web.registerSearchProvider({
        id: 'native',
        available: () => true,
        search: () => Promise.reject(new Error('single search must not run')),
        searchMany: request => Promise.resolve(request.queries.map((query) => {
          const count = (calls.get(query) ?? 0) + 1
          calls.set(query, count)
          if (query === 'failure' && count === 1) {
            return { query, error: { code: 'WEB_UPSTREAM', message: 'safe failure' } }
          }
          return { query, result: searchResult(`${query}-${count}`) }
        })),
      })

      await web.searchMany({ queries: ['ttl'] })
      now += 5
      await web.searchMany({ queries: ['ttl'] })
      expect(calls.get('ttl')).toBe(1)
      now += 6
      await web.searchMany({ queries: ['ttl'] })
      expect(calls.get('ttl')).toBe(2)
      await web.searchMany({ queries: ['failure'] })
      await web.searchMany({ queries: ['failure'] })
      expect(calls.get('failure')).toBe(2)
      await web.searchMany({ queries: ['other'] })
      await web.searchMany({ queries: ['ttl'] })
      expect(calls.get('ttl')).toBe(3)
    } finally {
      clock.mockRestore()
    }
  })

  it('singleflights overlapping queries while preserving each caller order', async () => {
    const { web } = await mountWeb({ searchProvider: 'native' })
    const requests: string[][] = []
    const batches: { queries: readonly string[]; gate: ReturnType<typeof deferredValue<readonly WebSearchBatchOutcome[]>> }[] = []
    web.registerSearchProvider({
      id: 'native',
      available: () => true,
      search: () => Promise.reject(new Error('single search must not run')),
      searchMany: (request) => {
        requests.push([...request.queries])
        const gate = deferredValue<readonly WebSearchBatchOutcome[]>()
        batches.push({ queries: request.queries, gate })
        return gate.promise
      },
    })

    const first = web.searchMany({ queries: ['one', 'shared'], mode: 'live' })
    await vi.waitFor(() => { expect(batches).toHaveLength(1) })
    const second = web.searchMany({ queries: ['shared', 'two'], mode: 'live' })
    await vi.waitFor(() => { expect(batches).toHaveLength(2) })
    for (const batch of batches) {
      batch.gate.resolve(batch.queries.map(query => ({ query, result: searchResult(query) })))
    }

    await expect(first).resolves.toMatchObject([{ query: 'one' }, { query: 'shared' }])
    await expect(second).resolves.toMatchObject([{ query: 'shared' }, { query: 'two' }])
    expect(requests).toEqual([['one', 'shared'], ['two']])
  })

  it('runs at most two native batches and drops a cancelled queued batch', async () => {
    const { web } = await mountWeb({ searchProvider: 'native', nativeBatchConcurrency: 2 })
    const releases: (() => void)[] = []
    let active = 0
    let maxActive = 0
    let calls = 0
    web.registerSearchProvider({
      id: 'native',
      available: () => true,
      search: () => Promise.reject(new Error('single search must not run')),
      searchMany: (request, signal) => new Promise((resolve) => {
        calls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        releases.push(() => {
          active -= 1
          resolve(request.queries.map(query => ({ query, result: searchResult(query) })))
        })
        signal?.addEventListener('abort', () => {}, { once: true })
      }),
    })

    const first = web.searchMany({ queries: ['one'], mode: 'live' })
    const second = web.searchMany({ queries: ['two'], mode: 'live' })
    const queuedController = new AbortController()
    const queued = web.searchMany({ queries: ['three'], mode: 'live' }, queuedController.signal)
    await vi.waitFor(() => { expect(calls).toBe(2) })
    queuedController.abort(new Error('cancel queued'))
    await expect(queued).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(calls).toBe(2)
    releases.forEach((release) => { release() })
    await Promise.all([first, second])
    expect(maxActive).toBe(2)
  })

  it('keeps shared work for remaining waiters and drains orphaned work before cancellation returns', async () => {
    const { web } = await mountWeb({ searchProvider: 'native' })
    const gates: ReturnType<typeof deferredValue<readonly WebSearchBatchOutcome[]>>[] = []
    const signals: AbortSignal[] = []
    web.registerSearchProvider({
      id: 'native',
      available: () => true,
      search: () => Promise.reject(new Error('single search must not run')),
      searchMany: (request, signal) => {
        if (signal === undefined) throw new Error('expected shared signal')
        signals.push(signal)
        const gate = deferredValue<readonly WebSearchBatchOutcome[]>()
        gates.push(gate)
        return gate.promise.then(() => request.queries.map(query => ({ query, result: searchResult(query) })))
      },
    })

    const firstController = new AbortController()
    const first = web.searchMany({ queries: ['shared'], mode: 'live' }, firstController.signal)
    await vi.waitFor(() => { expect(gates).toHaveLength(1) })
    const second = web.searchMany({ queries: ['shared'], mode: 'live' })
    firstController.abort(new Error('first cancelled'))
    await expect(first).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(signals[0]?.aborted).toBe(false)
    gates[0]?.resolve([])
    await expect(second).resolves.toMatchObject([{ query: 'shared' }])

    const orphanController = new AbortController()
    let orphanSettled = false
    const orphan = web.searchMany({ queries: ['orphan'], mode: 'live' }, orphanController.signal)
      .finally(() => { orphanSettled = true })
    await vi.waitFor(() => { expect(gates).toHaveLength(2) })
    orphanController.abort(new Error('orphan cancelled'))
    await vi.waitFor(() => { expect(signals[1]?.aborted).toBe(true) })
    expect(orphanSettled).toBe(false)
    const lateJoiner = web.searchMany({ queries: ['orphan'], mode: 'live' })
    await vi.waitFor(() => { expect(gates).toHaveLength(3) })
    expect(signals[2]?.aborted).toBe(false)
    gates[1]?.resolve([])
    await expect(orphan).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    gates[2]?.resolve([])
    await expect(lateJoiner).resolves.toMatchObject([{ query: 'orphan' }])
  })

  it('aborts and drains active work during service disposal', async () => {
    const { web, fiber } = await mountWeb({ searchProvider: 'native' })
    const gate = deferredValue<true>()
    let sharedSignal: AbortSignal | undefined
    web.registerSearchProvider({
      id: 'native',
      available: () => true,
      search: () => Promise.reject(new Error('single search must not run')),
      searchMany: (request, signal) => {
        sharedSignal = signal
        return gate.promise.then(() => request.queries.map(query => ({ query, result: searchResult(query) })))
      },
    })
    const pending = web.searchMany({ queries: ['dispose'], mode: 'live' })
    await vi.waitFor(() => { expect(sharedSignal).toBeDefined() })
    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(sharedSignal?.aborted).toBe(true)
    expect(disposed).toBe(false)
    gate.resolve(true)
    await disposal
    await expect(pending).resolves.toEqual([{
      query: 'dispose',
      error: { code: 'WEB_ABORTED', message: 'web search was cancelled' },
    }])
  })

  it('logs aggregate telemetry without query or URL text', async () => {
    const { ctx, web } = await mountWeb({ searchProvider: 'native' })
    const logs: string[] = []
    ctx.logger.debug = ((value: unknown) => { logs.push(String(value)) }) as typeof ctx.logger.debug
    web.registerSearchProvider({
      id: 'native',
      available: () => true,
      search: () => Promise.reject(new Error('single search must not run')),
      searchMany: request => Promise.resolve(request.queries.map(query => ({
        query,
        result: searchResult('answer', { sources: [{ url: 'https://secret.test/path' }] }),
      }))),
    })
    await web.searchMany({ queries: ['private query'] })
    await web.searchMany({ queries: ['private query'] })
    expect(logs).toHaveLength(2)
    expect(logs.join(' ')).toContain('cache_hits=1')
    expect(logs.join(' ')).not.toContain('private query')
    expect(logs.join(' ')).not.toContain('secret.test')
  })
})

describe('WebRuntime fetch capability', () => {
  it('resolves and runs the fetch provider independently of search', async () => {
    const { web } = await mountWeb()
    web.registerFetchProvider(makeFetchProvider('http', available, fetchResult('http')))
    const result = await web.fetch({ url: 'https://example.com' })
    expect(result.body.content).toBe('http')
    expect(result.statusCode).toBe(200)
  })

  it('throws WEB_PROVIDER_UNAVAILABLE for fetch when no fetch provider is registered', async () => {
    const { web } = await mountWeb()
    web.registerSearchProvider(makeSearchProvider('exa', available, () => Promise.resolve(searchResult('exa'))))
    await expect(web.fetch({ url: 'https://example.com' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }),
    )
  })
})

describe('WebError', () => {
  it('is a HarnessError carrying its code', () => {
    const error = new WebError('boom', 'WEB_INVALID_URL')
    expect(error.code).toBe('WEB_INVALID_URL')
    expect(error.name).toBe('WebError')
  })
})
