/**
 * Control queue projection coalescing: projection frames that queue up
 * undelivered keep only the newest complete value per (session, key) with
 * monotonic seq; queue frames are never coalesced or reordered; abort drops
 * the buffer while host teardown flushes the surviving latest frames.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { ControlQueue, SessionControlController } from '../src/control.ts'
import type { SessionControlFrame } from '../src/types.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'test/coalesce-user': LastUserState
    'test/coalesce-turns': number
  }
  interface SessionProjectionMap {
    'test/coalesce-user': { text: string } | null
    'test/coalesce-turns': number
  }
}

type ProjectionFrame = Extract<SessionControlFrame, { type: 'projection' }>
type QueueFrame = Extract<SessionControlFrame, { type: 'queue' }>

/** Whole-value unit folding the latest user/message text; null before the first. */
type LastUserState = { text: string } | null
const userUnit = () => ({
  key: 'test/coalesce-user',
  stateSchema: z.union([z.object({ text: z.string() }), z.null()]),
  init: () => null,
  apply: (state, event) => (event.type === 'user/message'
    ? { text: (event.data.content[0] as { text?: string }).text ?? '' }
    : state),
  wire: {
    viewSchema: z.union([z.object({ text: z.string() }), z.null()]),
    view: state => state,
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/coalesce-user', LastUserState>

/** Whole-value unit counting committed turn/start events. */
const turnUnit = () => ({
  key: 'test/coalesce-turns',
  stateSchema: z.number().int().nonnegative(),
  init: () => 0,
  apply: (state: number, event) => (event.type === 'turn/start' ? state + 1 : state),
  wire: {
    viewSchema: z.number().int().nonnegative(),
    view: state => state,
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/coalesce-turns', number>

/** Yield to the macrotask queue, letting every open stream drain its buffer. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

async function harness(): Promise<{
  ctx: Context
  session: Session
  control: SessionControlController
  inbox: Inbox
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  const session = ctx.sessions.create()
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  ctx.agents.register({ id: session.id, session, inbox, status: 'idle', ctx } as Agent)
  const control = new SessionControlController(ctx)
  ctx.sessionProjections.register(userUnit())
  ctx.sessionProjections.register(turnUnit())
  // The controller's onChanged subscription lives in an inject child whose
  // fiber activates asynchronously; yield until it lands before appending.
  await settle()
  return { ctx, session, control, inbox }
}

function message(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** Append `count` user messages m0..m{count-1} without yielding. */
function seedMessages(session: Session, count: number, from = 0): void {
  for (let index = from; index < from + count; index += 1) {
    session.append('user/message', message(`m${String(index)}`), { surfaceOp: 'append' })
  }
}

/** Open one control generation past its baseline. */
async function open(
  control: SessionControlController,
  abort: AbortController,
): Promise<AsyncGenerator<SessionControlFrame>> {
  const iterator = control.control(abort.signal)[Symbol.asyncIterator]()
  const opened = await iterator.next()
  if (opened.done || opened.value.type !== 'baseline') throw new Error('control stream ended before its baseline')
  return iterator as AsyncGenerator<SessionControlFrame>
}

/** Read the next frame, requiring one. */
async function nextFrame(iterator: AsyncGenerator<SessionControlFrame>): Promise<SessionControlFrame> {
  const next = await iterator.next()
  if (next.done) throw new Error('control stream ended before the expected frame')
  return next.value
}

describe('Session control queue coalescing', () => {
  it('physically unlinks superseded nodes and keeps stalled cardinality bounded', async () => {
    const queue = new ControlQueue()
    const sessionId = SessionId('stress')
    const keys = ['left', 'middle', 'right'] as const
    const pushes = 100_000
    let maximumSize = 0

    for (let seq = 0; seq < pushes; seq += 1) {
      const key = keys[seq % keys.length]!
      queue.push({ type: 'projection', sessionId, key, value: seq, seq })
      maximumSize = Math.max(maximumSize, queue.size)
    }
    expect(maximumSize).toBe(keys.length)
    expect(queue.size).toBe(keys.length)

    queue.end()
    const delivered: SessionControlFrame[] = []
    for await (const frame of queue.iterate(new AbortController().signal)) delivered.push(frame)

    expect(delivered).toEqual([
      { type: 'projection', sessionId, key: 'middle', value: 99_997, seq: 99_997 },
      { type: 'projection', sessionId, key: 'right', value: 99_998, seq: 99_998 },
      { type: 'projection', sessionId, key: 'left', value: 99_999, seq: 99_999 },
    ])
    expect(queue.size).toBe(0)
  })

  it('keeps collision-shaped Session and projection key pairs distinct', async () => {
    const queue = new ControlQueue()
    const firstSession = SessionId('nul-a\u0000nul-b')
    const secondSession = SessionId('nul-a')
    const firstKey = 'test/nul-c'
    const secondKey = 'nul-b\u0000test/nul-c'

    queue.push({ type: 'projection', sessionId: firstSession, key: firstKey, value: 'first-old', seq: 1 })
    queue.push({ type: 'projection', sessionId: secondSession, key: secondKey, value: 'second-old', seq: 2 })
    queue.push({ type: 'projection', sessionId: firstSession, key: firstKey, value: 'first-new', seq: 3 })
    queue.push({ type: 'projection', sessionId: secondSession, key: secondKey, value: 'second-new', seq: 4 })
    expect(queue.size).toBe(2)

    queue.end()
    const delivered: SessionControlFrame[] = []
    for await (const frame of queue.iterate(new AbortController().signal)) delivered.push(frame)
    expect(delivered).toEqual([
      { type: 'projection', sessionId: firstSession, key: firstKey, value: 'first-new', seq: 3 },
      { type: 'projection', sessionId: secondSession, key: secondKey, value: 'second-new', seq: 4 },
    ])
  })

  it('delivers only the newest value per unit when frames queue up undelivered', async () => {
    const { session, control } = await harness()
    const abort = new AbortController()
    const iterator = await open(control, abort)

    // No await between the appends, so every frame is still buffered when the
    // next one supersedes it — the shape a busy host event loop produces.
    seedMessages(session, 4)
    session.append('turn/start', { turn: 1 })

    const pushes: ProjectionFrame[] = []
    for (let count = 0; count < 2; count += 1) {
      const frame = await nextFrame(iterator)
      if (frame.type !== 'projection') throw new Error('expected a projection frame')
      pushes.push(frame)
    }
    abort.abort()
    await iterator.next()

    // One surviving frame per key, each carrying the final value at the final
    // seq: exactly the state a client that applied the whole run would hold.
    expect(pushes.map(push => push.key).sort()).toEqual(['test/coalesce-turns', 'test/coalesce-user'])
    expect(pushes.find(push => push.key === 'test/coalesce-user')).toEqual({
      type: 'projection', sessionId: session.id, key: 'test/coalesce-user', value: { text: 'm3' }, seq: 3,
    })
    expect(pushes.find(push => push.key === 'test/coalesce-turns')).toEqual({
      type: 'projection', sessionId: session.id, key: 'test/coalesce-turns', value: 1, seq: 4,
    })
  })

  it('keeps each key seq monotonic and never serves a superseded value across batches', async () => {
    const { session, control } = await harness()
    const abort = new AbortController()
    const iterator = await open(control, abort)

    // Two blocked batches with a pull between them: the first batch's newest
    // frame is delivered before the second batch appends, so both land.
    seedMessages(session, 2)
    const first = await nextFrame(iterator)
    seedMessages(session, 2, 2)
    const second = await nextFrame(iterator)
    abort.abort()
    await iterator.next()
    if (first.type !== 'projection' || second.type !== 'projection') {
      throw new Error('expected projection frames')
    }
    const pushes: ProjectionFrame[] = [first, second]

    // The intermediate m0/m2 values never left the queue, and the delivered
    // seqs strictly increase — the client's higher-seq-wins rule sees no replay.
    expect(pushes).toEqual([
      { type: 'projection', sessionId: session.id, key: 'test/coalesce-user', value: { text: 'm1' }, seq: 1 },
      { type: 'projection', sessionId: session.id, key: 'test/coalesce-user', value: { text: 'm3' }, seq: 3 },
    ])
  })

  it('never coalesces one projection key across sessions', async () => {
    const { ctx, session, control } = await harness()
    const second = ctx.sessions.create()
    const abort = new AbortController()
    const iterator = await open(control, abort)

    seedMessages(session, 1)
    seedMessages(second, 1)

    const pushes: ProjectionFrame[] = []
    for (let count = 0; count < 2; count += 1) {
      const frame = await nextFrame(iterator)
      if (frame.type !== 'projection') throw new Error('expected a projection frame')
      pushes.push(frame)
    }
    abort.abort()
    await iterator.next()

    // Same key, two sessions: a superseding key that mixed sessions would lose
    // one session's value.
    expect(new Set(pushes.map(push => push.sessionId)).size).toBe(2)
    expect(pushes.find(push => push.sessionId === session.id)).toMatchObject({ value: { text: 'm0' }, seq: 0 })
    expect(pushes.find(push => push.sessionId === second.id)).toMatchObject({ value: { text: 'm0' }, seq: 0 })
  })

  it('keeps every queue frame in push order while coalescing the projections beside them', async () => {
    const { session, control, inbox } = await harness()
    const abort = new AbortController()
    const iterator = await open(control, abort)

    const queued = [message('first'), message('second'), message('third')]
    // One synchronous run: whole-queue replacements interleave with projection
    // churn that coalesces around them.
    inbox.append('next-turn', queued[0]!)
    seedMessages(session, 1)
    inbox.append('next-turn', queued[1]!)
    seedMessages(session, 1, 1)
    inbox.append('next-turn', queued[2]!)

    const frames: SessionControlFrame[] = []
    const drained = (async () => {
      for await (const frame of iterator) {
        frames.push(frame)
        if (frames.filter(candidate => candidate.type === 'queue').length >= 3) abort.abort()
      }
    })()
    await drained

    // The durable queue replacements are the one thing coalescing must never
    // touch here: three splices, three frames, pushed order.
    const queues = frames.filter((frame): frame is QueueFrame => frame.type === 'queue')
    expect(queues.map(frame => frame.items.map(item => item.id))).toEqual([
      [queued[0]!.id],
      [queued[0]!.id, queued[1]!.id],
      [queued[0]!.id, queued[1]!.id, queued[2]!.id],
    ])
    // The interleaved projection churn still collapsed to the newest value
    // (the inbox splices own the even seqs between the user messages).
    const users = frames.filter((frame): frame is ProjectionFrame => frame.type === 'projection')
    expect(users).toEqual([{
      type: 'projection', sessionId: session.id, key: 'test/coalesce-user', value: { text: 'm1' }, seq: 3,
    }])
  })

  it('delivers the newer frame when supersession lands between wake and drain', async () => {
    const { session, control } = await harness()
    const abort = new AbortController()
    const iterator = await open(control, abort)

    // The consumer is parked on the queue's wake promise; the first push wakes
    // it, and the second supersedes before the resumed drain can run.
    const pending = iterator.next()
    seedMessages(session, 2)

    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { type: 'projection', key: 'test/coalesce-user', value: { text: 'm1' }, seq: 1 },
    })
    abort.abort()
    await iterator.next()
  })

  it('drops buffered frames on abort instead of flushing them', async () => {
    const { session, control } = await harness()
    const abort = new AbortController()
    const iterator = await open(control, abort)

    seedMessages(session, 3)
    abort.abort()

    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('flushes only the newest buffered projection per key when the host tears down', async () => {
    const { ctx, session, control } = await harness()
    const iterator = control.control(new AbortController().signal)[Symbol.asyncIterator]()
    const opened = await iterator.next()
    if (opened.done || opened.value.type !== 'baseline') throw new Error('control stream ended before its baseline')

    seedMessages(session, 3)
    await ctx.fiber.dispose()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'projection', key: 'test/coalesce-user', value: { text: 'm2' }, seq: 2 },
    })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })
})
