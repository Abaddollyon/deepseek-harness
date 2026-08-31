import { afterEach, describe, expect, it, vi } from 'vitest'

const listCalls: unknown[][] = []
const deleteCalls: unknown[][] = []
let emitAuthFailureWithUsage = false

type CredentialProxy = {
  list: (...args: unknown[]) => Promise<unknown>
  delete: (...args: unknown[]) => Promise<unknown>
}

vi.mock('@earendil-works/pi-ai', () => ({
  createModels: ({ credentials }: { credentials: CredentialProxy }) => ({
    setProvider: vi.fn(),
    getModel: () => ({
      id: 'deepseek-v4-flash',
      api: 'openai-completions',
      provider: 'deepseek',
      input: ['text'],
      contextWindow: 100000,
      maxTokens: 1000,
    }),
    streamSimple: async function* () {
      listCalls.push(await credentials.list({ signal: undefined }) as unknown[])
      deleteCalls.push(await credentials.delete('deepseek', { signal: undefined }) as unknown[])
      const message = {
        role: 'assistant',
        content: emitAuthFailureWithUsage ? [] : [{ type: 'text', text: 'proxy exercised' }],
        api: 'openai-completions',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
        stopReason: emitAuthFailureWithUsage ? 'error' : 'stop',
      }
      yield emitAuthFailureWithUsage
        ? { type: 'error', reason: 'error', error: { ...message, errorMessage: 'HTTP 401: rejected' } }
        : { type: 'done', reason: 'stop', message }
    },
  }),
  getSupportedThinkingLevels: () => [],
  isContextOverflow: () => false,
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('PiAiAdapter credential-store boundary', () => {
  afterEach(() => {
    listCalls.length = 0
    deleteCalls.length = 0
    emitAuthFailureWithUsage = false
  })

  it('delegates pi-ai list and delete through the attempt-local store', async () => {
    const auth = memoryAuth()
    const list = vi.spyOn(auth.credentials, 'list')
    const remove = vi.spyOn(auth.credentials, 'delete')
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ deepseek: { baseURL: 'http://example.test' } }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth,
    })

    const chunks = await collect(adapter.stream({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [],
    }))

    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(list).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
    expect(listCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(1)
  })

  it('emits terminal usage before an exhausted auth failure', async () => {
    emitAuthFailureWithUsage = true
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        deepseek: { baseURL: 'http://example.test', authRecovery: { retries: 0 } },
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    })

    const chunks = await collect(adapter.stream({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [],
    }))

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ type: 'usage' })
    expect(chunks[1]).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'AUTH' } },
    })
  })
})
