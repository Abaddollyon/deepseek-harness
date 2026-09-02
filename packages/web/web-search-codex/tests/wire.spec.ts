import { PassThrough } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { expect, it } from 'vitest'
import { CodexSearchWire } from '../src/wire.ts'

it('replays the Codex handshake and web search turn', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const peer = new JsonRpcLineTransport(output, input)
  peer.onRequest(async (method) => {
    if (method === 'initialize') return {}
    if (method === 'thread/start') return { thread: { id: 't1', ephemeral: true } }
    if (method === 'turn/start') {
      peer.notify('item/completed', { threadId: 't1', turnId: 'u1', item: { type: 'webSearch', results: [{ url: 'https://example.test', title: 'Example' }] } })
      peer.notify('turn/completed', { threadId: 't1', turn: { id: 'u1', status: 'completed' } })
      return { turn: { id: 'u1' } }
    }
    throw new Error('unexpected request '+method)
  })
  peer.start()
  const wire = new CodexSearchWire(input, output)
  wire.start()
  const signal = new AbortController().signal
  await wire.initialize(signal)
  await wire.startThread('/workspace', signal)
  const result = await wire.runTurn('test query', signal)
  expect(result.items).toHaveLength(1)
  expect(result.items[0]?.type).toBe('webSearch')
  wire.close()
})
