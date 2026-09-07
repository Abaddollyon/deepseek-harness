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
import { afterEach, expect, it } from 'vitest'
import * as SessionClient from '../src/client/index.ts'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
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
      context.reflect.provide('remote', {
        ...remote,
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
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const sessions = ctx.sessions
  await expect.poll(() => sessions.feed.getSnapshot().state).toBe('retrying')
  expect(sessions.list.getSnapshot().ids).toContain(SessionId('restored-session'))
  sessions.open(SessionId('restored-session'))
  const binding = sessions.binding(SessionId('restored-session'))
  hostReady = true
  await expect.poll(() => sessions.feed.getSnapshot().state).toBe('ready')
  expect(attempts).toBeGreaterThan(1)
  expect(attempts).toBeLessThanOrEqual(4)
  expect(sessions.list.getSnapshot().current).toBe(SessionId('restored-session'))
  expect(sessions.binding(SessionId('restored-session'))).toBe(binding)
  await ctx.fiber.dispose()
  const finalAttempts = attempts
  sessions.retryFeed()
  expect(attempts).toBe(finalAttempts)
})
