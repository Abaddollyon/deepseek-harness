import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider } from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

interface FakeContext {
  alive: Set<SubprocessHandle>
  children: SubprocessHandle[]
  cleanup?: () => Promise<void> | void
  context: Context
  providers: Map<string, WebSearchProvider>
  terminates: ReturnType<typeof vi.fn>[]
  turnStarted: Promise<boolean>
  waits: ReturnType<typeof vi.fn>[]
}

function fakeContext(): FakeContext {
  const providers = new Map<string, WebSearchProvider>()
  const alive = new Set<SubprocessHandle>()
  const children: SubprocessHandle[] = []
  const terminates: ReturnType<typeof vi.fn>[] = []
  const waits: ReturnType<typeof vi.fn>[] = []
  const started = Promise.withResolvers<boolean>()
  const runtime = {
    resolveExecutable: vi.fn(async (command: string) => command),
    spawn: vi.fn((_spec: SubprocessSpawnSpec) => {
      const clientInput = new PassThrough()
      const clientOutput = new PassThrough()
      const peer = new JsonRpcLineTransport(clientOutput, clientInput)
      peer.onRequest(async (method) => {
        if (method === 'initialize') return {}
        if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true } }
        if (method === 'turn/start') {
          started.resolve(true)
          return { turn: { id: 'turn-1' } }
        }
        if (method === 'turn/interrupt') return {}
        throw new Error(`unexpected method ${method}`)
      })
      peer.start()
      const done = Promise.withResolvers<SubprocessOutcome>()
      let settled = false
      const terminate = vi.fn(() => {
        if (settled) return
        settled = true
        alive.delete(child)
        done.resolve({ exitCode: null, signal: 'SIGTERM' })
      })
      const waitForExit = vi.fn(async () => {
        await done.promise
        return true
      })
      const child: SubprocessHandle = {
        pid: 123,
        stdin: clientOutput,
        stdout: clientInput,
        stderr: undefined,
        collected: {},
        done: done.promise,
        terminate,
        waitForExit,
      }
      terminates.push(terminate)
      waits.push(waitForExit)
      alive.add(child)
      children.push(child)
      return child
    }),
  } as unknown as SubprocessRuntime
  const value: FakeContext = {
    alive,
    children,
    context: undefined as unknown as Context,
    providers,
    terminates,
    turnStarted: started.promise,
    waits,
  }
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
  it('terminates in-flight children and unregisters codex on Fiber disposal', async () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('web-search-codex')
    expect(plugin.inject).toEqual(['web', 'subprocess'])
    const fake = fakeContext()
    plugin.apply(fake.context)
    const provider = fake.providers.get('codex')
    expect(provider).toEqual(expect.objectContaining({ id: 'codex' }))
    if (provider === undefined) throw new Error('expected codex provider')

    const pending = provider.search({ query: 'query' })
    await fake.turnStarted
    expect(fake.alive.size).toBe(1)
    expect(fake.cleanup).toBeTypeOf('function')
    await fake.cleanup?.()
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })

    expect(fake.providers.size).toBe(0)
    expect(fake.alive.size).toBe(0)
    expect(fake.children).toHaveLength(1)
    expect(fake.terminates[0]).toHaveBeenCalled()
    expect(fake.waits[0]).toHaveBeenCalled()
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
