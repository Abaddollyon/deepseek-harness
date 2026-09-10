import { PassThrough } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_AUTH_MESSAGE, CodexSearchProvider } from '../src/provider.ts'

/** Exercise structured login refusal through the real provider and JSON-RPC wire. */
describe('Codex login-required completion', () => {
  it('classifies authentication failure and waits for the owned process to exit', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const peer = new JsonRpcLineTransport(stdin, stdout)
    const done = Promise.withResolvers<SubprocessOutcome>()
    const terminate = vi.fn(() => { done.resolve({ exitCode: null, signal: 'SIGTERM' }) })
    const waitForExit = vi.fn(async () => { await done.promise; return true })
    const child: SubprocessHandle = { stdin, stdout, stderr: undefined, collected: {}, done: done.promise, terminate, waitForExit }
    peer.onRequest(async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'auth-thread', ephemeral: true } }
      if (method === 'turn/start') {
        peer.notify('turn/completed', { threadId: 'auth-thread', turn: { id: 'auth-turn', status: 'login required' } })
        return { turn: { id: 'auth-turn' } }
      }
      return {}
    })
    peer.start()
    const runtime = {
      resolveExecutable: vi.fn(async () => process.execPath),
      spawn: vi.fn(() => child),
    } as unknown as SubprocessRuntime
    const provider = new CodexSearchProvider(runtime, {
      cwd: process.cwd(), executable: process.execPath, requestTimeoutMs: 10_000,
      disposeGraceMs: 25, maxResults: 8, maxPayloadBytes: 262_144,
    })
    try {
      await expect(provider.search({ query: 'query' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE', message: CODEX_AUTH_MESSAGE,
      })
      expect(terminate).toHaveBeenCalled()
      expect(waitForExit).toHaveBeenCalled()
      await expect(done.promise).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    } finally {
      await provider.dispose()
      peer.close()
      stdin.destroy()
      stdout.destroy()
    }
  })
})
