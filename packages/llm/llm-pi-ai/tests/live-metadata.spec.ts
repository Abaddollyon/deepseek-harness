import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveProfiles } from '../src/config.ts'
import { fetchLiveMetadata, normalizeMetadata } from '../src/live-metadata.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function profile(provider: string) {
  return resolveProfiles({ [provider]: {} }).get(provider)!
}

describe('provider metadata protocols', () => {
  it('maps explicit Kimi and Anthropic capabilities without guessing from model names', () => {
    expect(normalizeMetadata([{ id: 'new-kimi', supports_image_in: true, supports_reasoning: false }]).models)
      .toEqual([{ id: 'new-kimi', input: ['text', 'image'], reasoningEfforts: false }])
    expect(normalizeMetadata([{
      id: 'new-claude', max_input_tokens: 500000, max_tokens: 20000,
      capabilities: {
        image_input: { supported: true },
        effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false } },
      },
    }]).models).toEqual([{
      id: 'new-claude', contextWindow: 500000, maxTokens: 20000,
      input: ['text', 'image'], reasoningEfforts: { low: 'low', high: 'high' },
    }])
  })

  it('paginates Anthropic with OAuth headers and bounds repeated cursors', async () => {
    const urls: string[] = []
    const headers: Headers[] = []
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      urls.push(url.href)
      headers.push(new Headers(options.headers))
      return Response.json({ data: [{ id: urls.length === 1 ? 'claude-one' : 'claude-two' }], has_more: urls.length === 1, last_id: 'claude-one' })
    })
    const result = await fetchLiveMetadata(profile('anthropic'), { apiKey: 'sk-ant-oat-fake' }, new AbortController().signal)
    expect(result.models.map(model => model.id)).toEqual(['claude-one', 'claude-two'])
    expect(urls).toEqual(['https://api.anthropic.com/v1/models?limit=1000', 'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-one'])
    expect(headers[0]?.get('authorization')).toBe('Bearer sk-ant-oat-fake')
    expect(headers[0]?.get('anthropic-version')).toBe('2023-06-01')
    expect(headers[0]?.get('anthropic-beta')).toContain('oauth-2025-04-20')
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ id: 'one' }], has_more: true, last_id: 'one' }))
    await expect(fetchLiveMetadata(profile('anthropic'), { apiKey: 'fake-key' }, new AbortController().signal)).rejects.toThrow(/discovery/)
  })

  it('negotiates Codex metadata publicly without sending account secrets to npm', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      requests.push({ url: url.href, headers: new Headers(options.headers) })
      if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.153.3' })
      return Response.json({ models: [
        { slug: 'new-codex', visibility: 'list', supported_in_api: true, max_context_window: 1000000, supported_reasoning_levels: [{ effort: 'high' }, { effort: 'ultra' }], model_messages: { instructions: 'DO NOT RETAIN' } },
        { slug: 'hidden', visibility: 'hide' },
        { slug: 'unsupported', visibility: 'list', supported_in_api: false },
      ] })
    })
    const token = `fake.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.sig`
    const result = await fetchLiveMetadata(profile('openai-codex'), { apiKey: token }, new AbortController().signal)
    expect(result).toEqual({ clientVersion: '0.153.3', models: [{ id: 'new-codex', contextWindow: 1000000, reasoningEfforts: { high: 'high' } }], excludedIds: ['hidden', 'unsupported'] })
    expect(requests[0]?.headers.get('authorization')).toBeNull()
    expect(requests[0]?.headers.get('chatgpt-account-id')).toBeNull()
    expect(requests[1]?.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.153.3')
    expect(requests[1]?.headers.get('authorization')).toBe(`Bearer ${token}`)
    expect(requests[1]?.headers.get('chatgpt-account-id')).toBe('test-account')
    expect(requests[1]?.headers.get('originator')).toBe('pi')
  })

  it('retains a successful Codex version when the public lookup fails', async () => {
    vi.stubGlobal('fetch', async (url: URL) => {
      if (url.hostname === 'registry.npmjs.org') throw new Error('offline')
      expect(url.searchParams.get('client_version')).toBe('0.153.2')
      return Response.json({ models: [{ slug: 'available', visibility: 'list' }] })
    })
    const auth = { apiKey: 'fake', headers: { 'chatgpt-account-id': 'test-account' } }
    const result = await fetchLiveMetadata(profile('openai-codex'), auth, new AbortController().signal, '0.153.2')
    expect(result.models.map(model => model.id)).toEqual(['available'])
  })

  it('uses the cached Codex version when public metadata hangs within the total deadline', async () => {
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      if (url.hostname === 'registry.npmjs.org') return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () =>{  reject(new Error('public lookup timeout')) }, { once: true })
      })
      return Response.json({ models: [{ slug: 'available', visibility: 'list' }] })
    })
    const route = resolveProfiles({ 'openai-codex': { modelDiscovery: { enabled: true, timeoutMs: 90 } } }).get('openai-codex')!
    const controller = new AbortController()
    const timer = setTimeout(() =>{  controller.abort() }, 200)
    try {
      const result = await fetchLiveMetadata(route, { apiKey: 'fake', headers: { 'chatgpt-account-id': 'test' } }, controller.signal, '0.153.2')
      expect(result.models.map(model => model.id)).toEqual(['available'])
    } finally { clearTimeout(timer) }
  })

  it.each([
    { data: [] },
    { data: [{ name: 'no id' }] },
    { data: Array.from({ length: 2001 }, (_, index) => ({ id: `model-${index}` })) },
  ])('rejects incomplete or over-limit catalogs', async (body) => {
    vi.stubGlobal('fetch', async () => Response.json(body))
    await expect(fetchLiveMetadata(profile('openai'), { apiKey: 'fake' }, new AbortController().signal)).rejects.toThrow(/discovery/)
  })

  it('bounds streamed response bytes and omits unsafe error bodies', async () => {
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
      controller.close()
    } })))
    await expect(fetchLiveMetadata(profile('openai'), { apiKey: 'fake' }, new AbortController().signal)).rejects.toThrow(/discovery/)
    vi.stubGlobal('fetch', async () => new Response('secret failure body', { status: 401 }))
    await expect(fetchLiveMetadata(profile('openai'), { apiKey: 'fake' }, new AbortController().signal)).rejects.not.toThrow(/secret/)
  })

  it('normalizes legacy capability fields, explicit modalities, exclusions, and duplicate IDs', () => {
    expect(normalizeMetadata([{
      id: 'legacy', name: 'Legacy', type: 'model', context_window: 100, max_tokens: 20,
      input_modalities: ['text', 'image', 'audio'], supported_reasoning_levels: ['off', { effort: 'max' }],
      capabilities: { thinking: { supported: false } },
    }]).models).toEqual([{
      id: 'legacy', name: 'Legacy', contextWindow: 100, maxTokens: 20,
      input: ['text', 'image'], reasoningEfforts: false,
    }])
    expect(normalizeMetadata([{ id: 'text-only', supports_image_in: false }]).models)
      .toEqual([{ id: 'text-only', input: ['text'] }])
    expect(normalizeMetadata([{ slug: 'hidden', visibility: 'internal' }], true)).toEqual({ models: [], excludedIds: ['hidden'] })
    expect(() => normalizeMetadata([{ id: 'same' }, { id: 'same' }])).toThrow(/discovery/)
  })

  it('rejects malformed response framing and aborts before reading', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
    await expect(fetchLiveMetadata(profile('openai'), { apiKey: 'fake' }, new AbortController().signal)).rejects.toThrow(/discovery/)
    const controller = new AbortController()
    controller.abort()
    await expect(fetchLiveMetadata(profile('openai'), { apiKey: 'fake' }, controller.signal)).rejects.toThrow()
  })

  it.each([
    [{ slug: 'model', visibility: 'list', supported_in_api: 'yes' }, true],
    [{ id: 'model', type: 'embedding' }, false],
  ] as const)('rejects malformed provider capability discriminants', (row, codex) => {
    expect(() => normalizeMetadata([row], codex)).toThrow(/discovery/)
  })

  it('keeps explicit off effort and conservative unknown capabilities', () => {
    expect(normalizeMetadata([
      { id: 'off', supported_reasoning_levels: ['off'] },
      { id: 'unknown', input_modalities: ['audio'], think_efforts: ['ultra'], capabilities: null },
      { id: 'thinking', capabilities: { thinking: { supported: true }, image_input: { supported: false } } },
    ]).models).toEqual([
      { id: 'off', reasoningEfforts: { off: null } },
      { id: 'unknown', reasoningEfforts: false },
      { id: 'thinking', input: ['text'] },
    ])
  })

  it('rejects a declared oversized response before consuming its body', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    }))
    await expect(fetchLiveMetadata(profile('openai'), {}, new AbortController().signal)).rejects.toThrow(/discovery/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(['abort', 'read failure'] as const)('contains a body cancellation failure after %s', async (mode) => {
    const entered = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const cancel = vi.fn(() => Promise.reject(new Error('cancel failed')))
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      start(value) { streamController = value },
      pull() { entered.resolve(undefined) },
      cancel,
    })))
    const result = fetchLiveMetadata(profile('openai'), {}, controller.signal)
    const rejected = expect(result).rejects.toThrow()
    await entered.promise
    if (mode === 'abort') controller.abort()
    else streamController!.error(new Error('read failed'))
    await rejected
    if (mode === 'abort') expect(cancel).toHaveBeenCalledOnce()
  })

  it('uses an already-versioned endpoint and supplied auth headers without a bearer key', async () => {
    const requests: Array<{ url: URL; headers: Headers }> = []
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      requests.push({ url, headers: new Headers(options.headers) })
      return Response.json({ data: [{ id: 'one' }] })
    })
    const route = resolveProfiles({ anthropic: { baseURL: 'https://proxy.invalid/v1/' } }).get('anthropic')!
    await fetchLiveMetadata(route, { headers: { 'x-api-key': 'header-key', omitted: null } }, new AbortController().signal)
    expect(requests[0]?.url.href).toBe('https://proxy.invalid/v1/models?limit=1000')
    expect(requests[0]?.headers.get('x-api-key')).toBe('header-key')
    expect(requests[0]?.headers.has('authorization')).toBe(false)
    expect(requests[0]?.headers.has('omitted')).toBe(false)
  })

  it('retains the stable version when npm returns a prerelease and avoids duplicating the Codex prefix', async () => {
    vi.stubGlobal('fetch', async (url: URL) => {
      if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '1.0.0-beta' })
      expect(url.href).toBe('https://proxy.invalid/codex/models?client_version=0.153.2')
      return Response.json({ models: [{ slug: 'one', visibility: 'list' }] })
    })
    const route = resolveProfiles({ 'openai-codex': { baseURL: 'https://proxy.invalid/codex' } }).get('openai-codex')!
    await expect(fetchLiveMetadata(route, { headers: { 'chatgpt-account-id': 'account' } }, new AbortController().signal, '0.153.2'))
      .resolves.toMatchObject({ clientVersion: '0.153.2', models: [{ id: 'one' }] })
  })

  it.each(['opaque-token', `head.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': {} })).toString('base64url')}.sig`])(
    'refuses Codex metadata when the credential cannot supply an account', async (apiKey) => {
      const fetch = vi.fn(async () => Response.json({ version: '0.153.2' }))
      vi.stubGlobal('fetch', fetch)
      await expect(fetchLiveMetadata(profile('openai-codex'), { apiKey }, new AbortController().signal)).rejects.toThrow(/discovery/)
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  it.each([['list', 'hide'], ['hide', 'list']] as const)('rejects contradictory Codex rows across pages (%s then %s)', async (first, second) => {
    let pages = 0
    vi.stubGlobal('fetch', async (url: URL) => {
      if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.153.2' })
      return Response.json({ models: [{ slug: 'same', visibility: ++pages === 1 ? first : second }], has_more: pages === 1, last_id: 'same' })
    })
    await expect(fetchLiveMetadata(profile('openai-codex'), { headers: { 'chatgpt-account-id': 'account' } }, new AbortController().signal))
      .rejects.toThrow(/discovery/)
    expect(pages).toBe(2)
  })

  it.each(['entries', 'pages'] as const)('bounds aggregate %s across distinct pagination cursors', async (bound) => {
    let pages = 0
    vi.stubGlobal('fetch', async () => {
      pages++
      return Response.json({ data: Array.from({ length: bound === 'entries' ? 1100 : 1 }, (_, index) => ({ id: `${pages}-${index}` })), has_more: true, last_id: `page-${pages}` })
    })
    await expect(fetchLiveMetadata(profile('anthropic'), { apiKey: 'key' }, new AbortController().signal)).rejects.toThrow(/discovery/)
    expect(pages).toBe(bound === 'entries' ? 2 : 10)
  })

  it('refuses metadata discovery without a route or auth endpoint for a provider with model-specific endpoints', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(fetchLiveMetadata(profile('amazon-bedrock'), {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses configured headers and ambient auth', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal('fetch', async (_url: URL, options: RequestInit) => {
      requests.push(options)
      return Response.json({ data: [{ id: 'ambient' }] })
    })
    const configured = resolveProfiles({ openai: { headers: { 'x-test': 'value' } } }).get('openai')!
    const result = await fetchLiveMetadata(configured, { headers: { authorization: 'ambient' } }, new AbortController().signal)
    expect(result.models[0]?.id).toBe('ambient')
    expect(new Headers(requests[0]?.headers).get('authorization')).toBe('ambient')
    expect(new Headers(requests[0]?.headers).get('x-test')).toBe('value')
  })
})
