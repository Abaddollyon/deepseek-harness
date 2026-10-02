import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface Recorded {
  url: string
  paths: string[]
  headers: IncomingMessage['headers'][]
  bodies: unknown[]
}

/** A stand-in pool answering every request with one fixed reply. */
async function poolServer(reply: { json?: unknown; sse?: readonly (readonly [string, unknown])[] }): Promise<Recorded> {
  const recorded: Omit<Recorded, 'url'> = { paths: [], headers: [], bodies: [] }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      recorded.paths.push(request.url ?? '')
      recorded.headers.push(request.headers)
      recorded.bodies.push(body.length === 0 ? undefined : JSON.parse(body))
      if (reply.json !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(reply.json))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [event, data] of reply.sse ?? []) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, ...recorded }
}

/** One Claude Code tool call, named in Claude Code's canonical casing. */
const TOOL_CALL_REPLY = [
  ['message_start', {
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 3, output_tokens: 0 } },
  }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }],
  ['message_stop', { type: 'message_stop' }],
] as const

/** A TeamClaude-style route on the catalog `anthropic` key. */
function teamClaude(baseURL: string, extra: Partial<PiAiProviderProfile> = {}): Record<string, PiAiProviderProfile> {
  return { anthropic: { baseURL, authMode: 'proxy', anthropicRequestMode: 'claude-code', ...extra } }
}

/** Stream one tool-offering request through a direct adapter whose store and ambient context are spies. */
async function dispatch(providers: Record<string, PiAiProviderProfile>, apiKey: string | undefined) {
  const auth = memoryAuth({
    anthropic: { type: 'oauth', access: 'stored-access', refresh: 'stored-refresh', expires: Date.now() + 3_600_000 },
  })
  const read = vi.spyOn(auth.credentials, 'read')
  const env = vi.spyOn(auth.authContext, 'env')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['anthropic'], new PiAiAdapter({
    profiles: () => resolveProfiles(providers),
    resolveApiKey: () => Promise.resolve(apiKey),
    auth,
  }))
  const result = await assemble(ctx, {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
  })
  return { result, read, env }
}

describe('proxy auth with Claude Code request mode', () => {
  it('sends a keyless Claude Code request without consulting stored or ambient credentials', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-api-key')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-auth-token')
    const pool = await poolServer({ sse: TOOL_CALL_REPLY })

    const { result, read, env } = await dispatch(teamClaude(pool.url), undefined)

    expect(read.mock.calls.map(([providerId]) => providerId)).not.toContain('anthropic')
    expect(env).not.toHaveBeenCalled()
    const headers = pool.headers[0] ?? {}
    expect(headers.authorization).toBeUndefined()
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['x-app']).toBe('cli')
    expect(headers['anthropic-beta']).toContain('claude-code-20250219')
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20')
    const body = pool.bodies[0] as { system?: { text: string }[]; tools?: { name: string }[] }
    expect(body.system?.[0]?.text).toMatch(/^You are Claude Code/)
    expect(body.tools?.map(tool => tool.name)).toContain('Read')
    expect(result.message.content).toContainEqual(expect.objectContaining({ type: 'tool-call', name: 'read' }))
  })

  it('sends only the configured pool key when the route names one', async () => {
    const pool = await poolServer({ sse: TOOL_CALL_REPLY })

    const { read } = await dispatch(teamClaude(pool.url, { apiKeyEnv: 'POOL_KEY' }), 'pool-key')

    expect(read.mock.calls.map(([providerId]) => providerId)).not.toContain('anthropic')
    expect(pool.headers[0]?.['x-api-key']).toBe('pool-key')
    expect(pool.headers[0]?.authorization).toBeUndefined()
    expect(pool.headers[0]?.['x-app']).toBe('cli')
  })

  it('keeps provider-native auth when the route does not opt into proxy mode', async () => {
    const pool = await poolServer({ sse: TOOL_CALL_REPLY })

    const { read } = await dispatch({ anthropic: { baseURL: pool.url } }, undefined)

    expect(read.mock.calls.map(([providerId]) => providerId)).toContain('anthropic')
  })
})

/** One plain OpenAI Chat Completions reply. */
const COMPLETION_REPLY = [
  ['message', { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'local-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }],
  ['message', { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'local-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
] as const

describe('keyless proxy on an OpenAI protocol', () => {
  it('sends no Authorization header and reads no ambient key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
    const pool = await poolServer({ sse: COMPLETION_REPLY })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['local'], new PiAiAdapter({
      profiles: () => resolveProfiles({
        local: { api: 'openai-completions', baseURL: `${pool.url}/v1`, authMode: 'proxy', models: [{ id: 'local-model' }] },
      }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({}),
    }))

    const result = await assemble(ctx, {
      provider: 'local',
      model: 'local-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'say ok' }], source: { kind: 'user' } })],
    })

    expect(pool.paths).toEqual(['/v1/chat/completions'])
    expect(pool.headers[0]?.authorization).toBeUndefined()
    expect(result.message.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'ok' }))
  })
})

describe('pool route configuration', () => {
  it.each([
    ['proxy without an endpoint', { anthropic: { authMode: 'proxy' } }, /authMode proxy/],
    ['proxy with embedded credentials', { anthropic: { authMode: 'proxy', baseURL: 'http://user:secret@127.0.0.1:3456' } }, /without embedded credentials/],
    ['proxy over a non-http scheme', { anthropic: { authMode: 'proxy', baseURL: 'ftp://127.0.0.1:3456' } }, /http\(s\)/],
    ['Claude Code format on a non-Anthropic protocol', { openai: { anthropicRequestMode: 'claude-code' } }, /anthropic-messages/],
    ['a listing source without an endpoint', { 'openai-codex': { modelDiscovery: { source: 'openai-compatible' } } }, /needs a baseURL/],
  ] as const)('rejects %s', (_name, providers, message) => {
    expect(() => resolveProfiles(providers as Record<string, PiAiProviderProfile>, 'deferred')).toThrow(message)
  })
})

/** The pool reply fields discovery reads, plus fields it must not retain. */
const CODEX_POOL_LISTING = {
  object: 'list',
  data: [{
    id: 'gpt-6.1-sol',
    object: 'model',
    metadata: {
      display_name: 'GPT-6.1-Sol',
      description: 'untrusted model instructions',
      context_window: 272000,
      max_output_tokens: null,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        .map(effort => ({ effort, description: 'untrusted model instructions' })),
    },
    capabilities: { context_length: 272000, max_output_tokens: null, supports_reasoning: true, input_modalities: ['text', 'image'] },
    context_length: 272000,
    max_output_tokens: null,
  }],
}

/** Two TeamClaude rows: one with efforts and adaptive thinking, one supporting only budget thinking. */
const TEAMCLAUDE_LISTING = {
  data: [
    {
      type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1000000, max_tokens: 128000,
      capabilities: {
        effort: {
          supported: true,
          ...Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map(level => [level, { supported: true }])),
        },
        image_input: { supported: true },
        thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
      },
    },
    {
      type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200000, max_tokens: 64000,
      capabilities: {
        effort: { supported: false },
        image_input: { supported: true },
        thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } },
      },
    },
  ],
  has_more: false,
}

async function mount(providers: Record<string, PiAiProviderProfile>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers })
  return ctx
}

describe('pool model discovery', () => {
  it('lists an OpenAI-compatible pool behind a catalog route, keeping only supported efforts', async () => {
    vi.stubEnv('POOL_KEY', 'pool-key')
    const pool = await poolServer({ json: CODEX_POOL_LISTING })
    const ctx = await mount({
      'openai-codex': {
        api: 'openai-responses',
        baseURL: `${pool.url}/v1`,
        apiKeyEnv: 'POOL_KEY',
        authMode: 'proxy',
        modelDiscovery: { source: 'openai-compatible' },
      },
    })

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' })

    expect(pool.paths).toEqual(['/v1/models'])
    expect(pool.headers[0]?.authorization).toBe('Bearer pool-key')
    expect(pool.headers[0]?.['chatgpt-account-id']).toBeUndefined()
    expect(models).toEqual([{
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1-Sol',
      contextWindow: 272000,
      inputModalities: ['text', 'image'],
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }])
    expect(JSON.stringify(models)).not.toContain('untrusted')
  })

  it('lists a keyless Anthropic pool with its reported efforts and thinking mode', async () => {
    const pool = await poolServer({ json: TEAMCLAUDE_LISTING })
    const ctx = await mount(teamClaude(pool.url, { modelDiscovery: { source: 'anthropic' } }))

    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'anthropic' })

    expect(pool.paths).toEqual(['/v1/models?limit=1000'])
    expect(pool.headers[0]?.['x-api-key']).toBeUndefined()
    expect(pool.headers[0]?.['anthropic-version']).toBe('2023-06-01')
    expect(models).toEqual([
      {
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        contextWindow: 1000000,
        maxTokens: 128000,
        inputModalities: ['text', 'image'],
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        compat: { forceAdaptiveThinking: true },
      },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000, maxTokens: 64000, inputModalities: ['text', 'image'] },
    ])
  })
})
