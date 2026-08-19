/**
 * History-page emission of streaming deltas: a step whose terminal
 * `assistant/message` sits on the same page ships neither its content deltas
 * nor its `finish` chunk, a step still in flight ships every delta, the first
 * token delta and each `usage` chunk survive settlement, the terminal content
 * a reader reconstructs is identical either way, and the deployment can serve
 * the raw stream by turning the projection off.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`hist-${String(nextRpc++)}`), payload }
}

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create()
  ctx.agents.register({
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
  } as Agent)
  return { ctx, session }
}

const proxy = (ctx: Context, historyElideSettledDeltas?: boolean) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
  cwd: '/tmp',
  ...historyElideSettledDeltas === undefined ? {} : { historyElideSettledDeltas },
})

function appendUserText(session: Session, text: string): SessionEvent {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function appendChunk(session: Session, step: number, chunk: StreamChunk): SessionEvent {
  return session.append('assistant/chunk', { turn: 1, step, chunk })
}

/** Stream one text block as the loop records it: block open, deltas, block close. */
function streamText(session: Session, step: number, pieces: readonly string[]): SessionEvent[] {
  const seqs = [appendChunk(session, step, { type: 'block-start', index: 0, blockType: 'text' })]
  for (const text of pieces) seqs.push(appendChunk(session, step, { type: 'text-delta', index: 0, text }))
  seqs.push(appendChunk(session, step, {
    type: 'block-end', index: 0, block: { type: 'text', text: pieces.join('') },
  }))
  return seqs
}

/** Close one step the way the loop does: usage, finish, the assembled message, step/end. */
function settleStep(session: Session, step: number, text: string): SessionEvent {
  appendChunk(session, step, { type: 'usage', usage: { inputTokens: 7, outputTokens: 11 } })
  appendChunk(session, step, { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'r1' } } })
  const message = session.append('assistant/message', {
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step })
  return message
}

async function page(ctx: Context, session: Session, elide?: boolean): Promise<SessionEvent[]> {
  const response = await proxy(ctx, elide).sessions.history(request({ sessionId: session.id }))
  if (!response.result.ok) throw new Error('history failed')
  return response.result.value.events.map(entry => entry.event)
}

/**
 * The blocks a reader reconstructs, folded exactly as the browser's Assistant
 * Definition does: chunks accumulate, the step's own message replaces them.
 */
function reconstruct(events: readonly SessionEvent[]): Record<string, unknown> {
  const steps = new Map<number, { text: string; usage?: unknown; firstTokenTime?: number }>()
  for (const event of events) {
    if (event.type === 'assistant/chunk') {
      const state = steps.get(event.data.step) ?? { text: '' }
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') {
        state.text += chunk.text
        state.firstTokenTime ??= event.time
      } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
        state.text = chunk.block.text
      } else if (chunk.type === 'usage') {
        state.usage = chunk.usage
      }
      steps.set(event.data.step, state)
      continue
    }
    if (event.type !== 'assistant/message') continue
    const state = steps.get(event.data.step) ?? { text: '' }
    const block = event.data.message.content[0]
    state.text = block?.type === 'text' ? block.text : ''
    steps.set(event.data.step, state)
  }
  return Object.fromEntries([...steps].map(([step, state]) => [String(step), state]))
}

describe('session.history settled-step delta elision', () => {
  it('omits a settled step\'s superseded deltas while keeping its first token delta and usage', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    appendUserText(session, 'hello')
    session.append('step/start', { turn: 1, step: 1 })
    const streamed = streamText(session, 1, ['he', 'llo', ' world'])
    settleStep(session, 1, 'hello world')

    const events = await page(ctx, session)
    const chunks = events.filter(event => event.type === 'assistant/chunk')
    expect(chunks.map(event => event.data.chunk.type)).toEqual(['text-delta', 'usage'])
    // The surviving delta is the FIRST token, the one that stamps step timing.
    expect(chunks[0]?.seq).toBe(streamed[1]?.seq)
    // Every other recorded chunk stays in the log and off the page.
    expect(session.events.filter(event => event.type === 'assistant/chunk')).toHaveLength(7)
    expect(events.some(event => event.type === 'assistant/message')).toBe(true)
  })

  it('keeps every delta of a step still in flight', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    appendUserText(session, 'first')
    session.append('step/start', { turn: 1, step: 1 })
    streamText(session, 1, ['done'])
    settleStep(session, 1, 'done')
    session.append('step/start', { turn: 1, step: 2 })
    streamText(session, 2, ['par', 'tial'])

    const events = await page(ctx, session)
    const live = events.filter(event => event.type === 'assistant/chunk' && event.data.step === 2)
    expect(live.map(event => (event as SessionEvent<'assistant/chunk'>).data.chunk.type))
      .toEqual(['block-start', 'text-delta', 'text-delta', 'block-end'])
    // The settled step above it is trimmed in the same page.
    expect(events.filter(event => event.type === 'assistant/chunk' && event.data.step === 1))
      .toHaveLength(2)
    // The page still ends on the log's last event, so the client window stays continuous.
    expect(events.at(-1)?.seq).toBe(session.seq - 1)
  })

  it('keeps a delta recorded after its step\'s terminal message', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    appendUserText(session, 'hi')
    session.append('step/start', { turn: 1, step: 1 })
    streamText(session, 1, ['a'])
    settleStep(session, 1, 'a')
    // Nothing restates a delta that arrives after the message, so it is not superseded.
    const trailing = appendChunk(session, 1, { type: 'text-delta', index: 1, text: 'late' })

    const events = await page(ctx, session)
    expect(events.some(event => event.seq === trailing.seq)).toBe(true)
  })

  it('does not let a replacement copy settle the step it restates', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    const prompt = appendUserText(session, 'hi')
    session.append('step/start', { turn: 1, step: 1 })
    const streamed = streamText(session, 1, ['par', 'tial'])
    // A model-only replacement copy naming the same step: it restates a
    // shadowed range for the model and never entered the transcript, so the
    // step is still unsettled for a reader and keeps every delta.
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, {
      surfaceOp: { op: 'replace', start: prompt.seq, end: prompt.seq },
      sourceEventSeqs: [prompt.seq, ...streamed.map(event => event.seq)],
    })

    const events = await page(ctx, session)
    expect(events.filter(event => event.type === 'assistant/chunk')).toHaveLength(streamed.length)
  })

  it('serves a page with no assistant message unchanged', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    appendUserText(session, 'only a prompt')
    session.append('step/start', { turn: 1, step: 1 })
    streamText(session, 1, ['x'])

    const events = await page(ctx, session)
    expect(events.map(event => event.seq)).toEqual(session.events.map(event => event.seq))
  })

  it('reconstructs the same terminal content the unelided log yields', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    appendUserText(session, 'go')
    session.append('step/start', { turn: 1, step: 1 })
    streamText(session, 1, ['al', 'pha'])
    settleStep(session, 1, 'alpha')
    session.append('step/start', { turn: 1, step: 2 })
    streamText(session, 2, ['be', 'ta'])
    settleStep(session, 2, 'beta')

    const elided = await page(ctx, session)
    // The whole log fits this page, so the durable events ARE the unelided page.
    const raw = [...session.events]
    expect(elided.length).toBeLessThan(raw.length)
    expect(JSON.stringify(reconstruct(elided))).toBe(JSON.stringify(reconstruct(raw)))
    // Both pages carry the same terminal events verbatim.
    const terminals = (events: readonly SessionEvent[]): unknown =>
      events.filter(event => event.type === 'assistant/message')
    expect(JSON.stringify(terminals(elided))).toBe(JSON.stringify(terminals(raw)))
  })

  it('ends a page-up exactly at beforeSeq - 1 so the client window stays continuous', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    appendUserText(session, 'one')
    session.append('step/start', { turn: 1, step: 1 })
    streamText(session, 1, ['al', 'pha'])
    settleStep(session, 1, 'alpha')
    appendUserText(session, 'two')
    session.append('step/start', { turn: 1, step: 2 })
    streamText(session, 2, ['be', 'ta'])
    const boundary = settleStep(session, 2, 'beta')

    const response = await proxy(ctx).sessions.history(request({
      sessionId: session.id, beforeSeq: boundary.seq, maxMessages: 50,
    }))
    if (!response.result.ok) throw new Error('history failed')
    const events = response.result.value.events.map(entry => entry.event)
    expect(events.at(-1)?.seq).toBe(boundary.seq - 1)
    // Step 2 has no terminal message below the bound, so its deltas all ride along.
    expect(events.filter(event => event.type === 'assistant/chunk' && event.data.step === 2))
      .toHaveLength(6)
  })

  it('holds a heavily streamed page to two chunks per settled step', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    appendUserText(session, 'stream a lot')
    const pieces = Array.from({ length: 200 }, (_unused, index) => `token${String(index)} `)
    for (const step of [1, 2, 3, 4, 5]) {
      session.append('step/start', { turn: 1, step })
      streamText(session, step, pieces)
      settleStep(session, step, pieces.join(''))
    }
    const raw = [...session.events]

    const events = await page(ctx, session)
    const chunks = events.filter(event => event.type === 'assistant/chunk')
    // Five settled steps: one first-token delta and one usage chunk each.
    expect(chunks).toHaveLength(10)
    // 5 steps x (block-start + 200 deltas + block-end + usage + finish).
    expect(raw.filter(event => event.type === 'assistant/chunk')).toHaveLength(1020)
    expect(events.length * 20).toBeLessThan(raw.length)
    expect(JSON.stringify(events).length * 4).toBeLessThan(JSON.stringify(raw).length)
  })

  it('serves every recorded delta when the deployment disables the projection', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    appendUserText(session, 'raw')
    session.append('step/start', { turn: 1, step: 1 })
    streamText(session, 1, ['one', 'two'])
    settleStep(session, 1, 'onetwo')

    const events = await page(ctx, session, false)
    expect(events.map(event => event.seq)).toEqual(session.events.map(event => event.seq))
  })
})
