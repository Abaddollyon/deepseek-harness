import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveProfiles } from '../src/config.ts'
import { fetchLiveMetadata, normalizeMetadata } from '../src/live-metadata.ts'

afterEach(() => vi.unstubAllGlobals())

function profile(provider: string) {
  return resolveProfiles({ [provider]: {} }).get(provider)!
}

describe('provider metadata protocols', () => {
  it('maps explicit Kimi and Anthropic capabilities without guessing from model names', () => {
    expect(normalizeMetadata([{ id: 'new-kimi', supports_image_in: true, supports_reasoning: false }]))
      .toEqual([{ id: 'new-kimi', input: ['text', 'image'], reasoningEfforts: false }])
    expect(normalizeMetadata([{
      id: 'new-claude', max_input_tokens: 500000, max_tokens: 20000,
      capabilities: {
        image_input: { supported: true },
        effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false } },
      },
    }])).toEqual([{
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
    expect(result).toEqual({ clientVersion: '0.153.3', models: [{ id: 'new-codex', contextWindow: 1000000, reasoningEfforts: { high: 'high' } }] })
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
})
