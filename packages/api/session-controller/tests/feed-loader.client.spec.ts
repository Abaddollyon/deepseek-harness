import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { afterEach, expect, it, vi } from 'vitest'
import * as SessionClient from '../src/client/index.ts'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  try {
    await ctx?.fiber.dispose()
  } finally {
    vi.useRealTimers()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
})

it('loads the client before Host session readiness and recovers retained sessions through the configured budget', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-feed-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: session-client',
    '  config:',
    '    controlRetryDelaysMs: [5, 10, 20]',
    '- name: typert',
    '- name: fixture-remote',
    '',
  ].join('\n'))
  const api = new FakeApiClient()
  const remote = fakeRemote(api)
  const originalControl = remote.session.control
  let hostReady = false
  let attempts = 0
  remote.session.control = async function* (signal) {
    attempts++
    if (!hostReady) {
      throw new RemoteError('gateway/service-unavailable', 'Session service is starting', { endpoint: 'session/control' })
    }
    yield* originalControl(signal)
  }
  api.onList = async () => ok({ items: [{
    sessionId: SessionId('restored-session'), updatedAt: 42, running: false, blank: false,
  }] as never[] })
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['session-client', SessionClient],
    ['typert', TypertRegistry],
    ['fixture-remote', { apply(context: Context) {
      const generation = { id: 1, host: { home: '/fixture' } }
      const connection: ConnectionHandle = {
        isLoopback: true,
        generation: { getSnapshot: () => generation, subscribe: () => () => {} },
        state: { getSnapshot: () => 'connected', subscribe: () => () => {} },
        rpc: { call: () => Promise.reject(new Error('unexpected generic RPC call')) },
        reconnect: () => {},
        registerGenerationSource: () => () => {},
        start: () => ({ stop: () => {} }),
      }
      context.reflect.provide('connection', connection)
      context.reflect.provide('fileUpload', {
        available: true,
        post: () => Promise.reject(new Error('unexpected file upload')),
      })
      context.reflect.provide('remote', {
        ...remote,
        $stream: <Item>(options: RemoteStreamOptions<Item>) => new RemoteStream(connection, options),
        $host: { home: '/fixture', isLoopback: true },
        $on: () => () => {},
      })
      context.reflect.provide('remote.commands', remote.commands)
      context.reflect.provide('remote.session', remote.session)
      context.reflect.provide('remote.subagents', remote.subagents)
    } }],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const sessions = ctx.sessions
  expect(sessions !== undefined).toBe(true)
  await vi.waitFor(() => { expect(sessions.feed.getSnapshot().state).toBe('retrying') }, { interval: 1 })
  expect(sessions.list.getSnapshot().ids).toContain(SessionId('restored-session'))
  sessions.open(SessionId('restored-session'))
  const binding = sessions.binding(SessionId('restored-session'))
  expect(attempts).toBe(1)
  hostReady = true
  await vi.advanceTimersByTimeAsync(5)
  await vi.waitFor(() => { expect(sessions.feed.getSnapshot().state).toBe('ready') }, { interval: 1 })
  expect(attempts).toBe(2)
  expect(sessions.list.getSnapshot().current).toBe(SessionId('restored-session'))
  expect(sessions.binding(SessionId('restored-session'))).toBe(binding)
  await ctx.fiber.dispose()
  const finalAttempts = attempts
  sessions.retryFeed()
  await vi.runAllTimersAsync()
  expect(attempts).toBe(finalAttempts)
})
