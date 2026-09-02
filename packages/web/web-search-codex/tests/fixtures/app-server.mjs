#!/usr/bin/env node
import { createInterface } from 'node:readline'

const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
const source = (query, ordinal) => ({
  url: `https://subscription.example.test/${encodeURIComponent(query)}/${ordinal}`,
  title: `Subscription result ${ordinal}`,
  snippet: `Offline subscription replay source ${ordinal} for ${query}.`,
  publishedAt: `2001-01-0${ordinal}T00:00:00Z`,
})

createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') return respond(frame.id, {})
  if (frame.method === 'initialized') return
  if (frame.method === 'thread/start') return respond(frame.id, { thread: { id: 'offline-thread', ephemeral: true } })
  if (frame.method === 'turn/start') {
    if (process.env.DSH_REPLAY_CODEX_AUTH === '1') {
      notify('turn/completed', { threadId: 'offline-thread', turnId: 'offline-turn', turn: { id: 'offline-turn', status: 'login required' } })
      return respond(frame.id, { turn: { id: 'offline-turn' } })
    }
    const text = frame.params.input[0].text
    const match = /Search exactly as supplied: (.*) Use no other tools/u.exec(text)
    const query = match?.[1] ?? 'offline-query'
    notify('item/completed', {
      threadId: 'offline-thread', turnId: 'offline-turn',
      item: { type: 'webSearch', query, results: Array.from({ length: 6 }, (_, index) => source(query, index + 1)) },
    })
    notify('item/completed', {
      threadId: 'offline-thread', turnId: 'offline-turn',
      item: { type: 'agentMessage', final_answer: `Offline Codex answer for ${query}.` },
    })
    notify('turn/completed', {
      threadId: 'offline-thread', turn: { id: 'offline-turn', status: 'completed' },
    })
    return respond(frame.id, { turn: { id: 'offline-turn' } })
  }
  if (frame.method === 'turn/interrupt') return respond(frame.id, {})
  respond(frame.id, {})
})
