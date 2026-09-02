import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

interface FakeContext {
  cleanup?: () => Promise<void> | void
  context: Context
  providers: Map<string, WebSearchProvider>
  spawn: ReturnType<typeof vi.fn>
}

function fakeContext(): FakeContext {
  const providers = new Map<string, WebSearchProvider>()
  const spawn = vi.fn()
  const runtime = {
    resolveExecutable: vi.fn(async (command: string) => command),
    spawn,
  } as unknown as SubprocessRuntime
  const value: FakeContext = { context: undefined as unknown as Context, providers, spawn }
  value.context = {
    subprocess: runtime,
    web: {
      registerSearchProvider(provider: WebSearchProvider): () => void {
        if (providers.has(provider.id)) {
          throw new WebError(
            `a web provider with id "${provider.id}" is already registered`,
            'WEB_DUPLICATE_PROVIDER',
          )
        }
        providers.set(provider.id, provider)
        return () => { providers.delete(provider.id) }
      },
    },
    effect(factory: () => Generator<() => Promise<void> | void>): () => Promise<void> {
      const iterator = factory()
      const next = iterator.next()
      if (!next.done) value.cleanup = next.value
      return async () => { await value.cleanup?.() }
    },
  } as unknown as Context
  return value
}

describe('Codex plugin loader composition', () => {
  it('declares required seams, registers codex, and unregisters on Fiber disposal', async () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('web-search-codex')
    expect(plugin.inject).toEqual(['web', 'subprocess'])
    const fake = fakeContext()
    plugin.apply(fake.context)
    expect([...fake.providers]).toEqual([['codex', expect.objectContaining({ id: 'codex' })]])
    expect(fake.cleanup).toBeTypeOf('function')
    await fake.cleanup?.()
    expect(fake.providers.size).toBe(0)
    expect(fake.spawn).not.toHaveBeenCalled()
  })

  it('rejects duplicate fixed-id registration', () => {
    const fake = fakeContext()
    plugin.apply(fake.context, {
      cwd: process.cwd(),
      requestTimeoutMs: 1,
      disposeGraceMs: 1,
      maxResults: 1,
      maxPayloadBytes: 1_048,
      executable: 'codex',
    })
    expect(() => { plugin.apply(fake.context) }).toThrow(
      expect.objectContaining({ code: 'WEB_DUPLICATE_PROVIDER' }),
    )
  })
})
