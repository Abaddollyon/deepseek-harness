/**
 * Opt-in host-side benchmark for mux streaming fan-out cost: how much CPU the
 * gateway spends turning one session event into frames for N connected mux
 * consumers, and what one stream open costs against a large session catalog.
 *
 * It reports measurements without timing assertions (host speed is not a
 * correctness contract); structural assertions keep the frame counts and the
 * session cardinality from silently shrinking, so a "faster" run that stopped
 * delivering frames fails instead of scoring well.
 */
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

// The real deployment this benchmark models: ~1560 sessions in the catalog and
// one conversation of ~1724 events. Stream counts bracket a single browser tab
// against a handful of tabs/windows on the same host.
const CATALOG_SESSIONS = 1_560
const LONG_SESSION_EVENTS = 1_724
const STREAM_COUNTS = [0, 1, 2, 4, 8] as const
const BURST_TURNS = 200
const TOOL_TURN_INTERVAL = 5

const reply = (): Promise<{ type: 'text'; text: string }[]> => Promise.resolve([{ type: 'text', text: 'ok' }])

function seedTools(ctx: Context): void {
  ctx.tools.register(defineContentToolFixture({
    name: 'bench-generic',
    description: 'generic card tool',
    parameters: {},
    execute: reply,
    presentCall: args => ({ card: 'generic', title: String((args as { title?: string }).title ?? 'call') }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'failed' : 'done' }),
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'bench-terminal',
    description: 'terminal card tool',
    parameters: {},
    execute: reply,
    presentCall: args => ({ card: 'terminal', title: String((args as { cmd?: string }).cmd ?? '') }),
    presentResult: () => ({ card: 'terminal', output: 'done' }),
  }))
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  // The four token-meter units are what a real deployment's projection churn
  // looks like: whole-value snapshots recomputed on nearly every event.
  await ctx.plugin(TokenMeter)
  seedTools(ctx)
  return ctx
}

/** Register a live Agent so the gateway's per-event agent lookups hit. */
function attachAgent(ctx: Context, session: Session): void {
  ctx.agents.register({
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
  } as Agent)
}

/** One assistant text step: the shape that dominates a streaming turn's log. */
function appendAssistant(session: Session, turn: number, step: number): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `turn ${String(turn)} step ${String(step)} body` }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
  }, { surfaceOp: 'append' })
}

/** One tool call/result pair, the only events whose frames carry a computed view. */
function appendToolPair(session: Session, turn: number, step: number, index: number): void {
  const callId = CallId(`bench-${String(turn)}-${String(index)}`)
  const name = index % 2 === 0 ? 'bench-generic' : 'bench-terminal'
  session.append('tool/call', {
    turn, step, callId, name,
    arguments: JSON.stringify({ title: `call ${String(index)}`, cmd: 'echo hi' }),
  })
  session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' })
}

/** Grow one session to roughly `target` events with a production-shaped mix. */
function growSession(session: Session, target: number): void {
  let turn = 0
  while (session.events.length < target) {
    turn += 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendAssistant(session, turn, 1)
    if (turn % TOOL_TURN_INTERVAL === 0) {
      for (let index = 0; index < 4; index += 1) appendToolPair(session, turn, 2, index)
      appendAssistant(session, turn, 3)
    }
    session.append('turn/end', { turn })
  }
}

/** Emit the measured burst and return how many events reached the log. */
function emitBurst(session: Session, turns: number): number {
  const before = session.events.length
  for (let turn = 10_000; turn < 10_000 + turns; turn += 1) {
    session.append('turn/start', { turn })
    for (let step = 1; step <= 3; step += 1) appendAssistant(session, turn, step)
    if (turn % TOOL_TURN_INTERVAL === 0) {
      for (let index = 0; index < 4; index += 1) appendToolPair(session, turn, 4, index)
    }
    session.append('turn/end', { turn })
  }
  return session.events.length - before
}

/** Drain one mux stream into a counter until the abort signal ends it. */
function drain(stream: AsyncIterable<RpcRequest<MuxFrame>>, counter: Counter): Promise<void> {
  return (async () => {
    for await (const envelope of stream) {
      counter.frames += 1
      const type = envelope.payload.type
      if (type === 'session/event') counter.events += 1
      counter.byType[type] = (counter.byType[type] ?? 0) + 1
    }
  })()
}

interface Counter { frames: number; events: number; byType: Record<string, number> }

function newCounter(): Counter {
  return { frames: 0, events: 0, byType: {} }
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

describe('manual host performance: mux fan-out', () => {
  it('reports per-stream open cost and per-event fan-out cost', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const catalogStart = performance.now()
    for (let index = 0; index < CATALOG_SESSIONS; index += 1) ctx.sessions.create()
    const long = ctx.sessions.create()
    attachAgent(ctx, long)
    growSession(long, LONG_SESSION_EVENTS)
    const seedMs = performance.now() - catalogStart

    expect(ctx.sessions.list().length).toBe(CATALOG_SESSIONS + 1)
    expect(long.events.length).toBeGreaterThanOrEqual(LONG_SESSION_EVENTS)

    const report: Record<string, unknown>[] = []
    // The 0-stream row prices session.append itself, so every later row's
    // marginal column is fan-out cost alone rather than logging cost.
    let baseEmitMs = 0
    for (const streams of STREAM_COUNTS) {
      const aborts: AbortController[] = []
      const counters: Counter[] = []
      const drains: Promise<void>[] = []

      const openStart = performance.now()
      const openCpu = process.cpuUsage()
      for (let index = 0; index < streams; index += 1) {
        const abort = new AbortController()
        aborts.push(abort)
        const counter = newCounter()
        counters.push(counter)
        const stream = api.events.mux({ rpcId: RpcId(`bench-mux-${String(streams)}-${String(index)}`), payload: {} }, abort.signal)
        drains.push(drain(stream, counter))
      }
      const openMs = performance.now() - openStart
      const openCpuMs = cpuMs(process.cpuUsage(openCpu))

      // Let the baseline frames drain so the burst measures steady-state fan-out.
      await new Promise(resolve => setTimeout(resolve, 50))
      const baselineFrames = counters.reduce((sum, c) => sum + c.frames, 0)

      const burstStart = performance.now()
      const burstCpu = process.cpuUsage()
      const emitted = emitBurst(long, BURST_TURNS)
      const emitMs = performance.now() - burstStart
      const emitCpuMs = cpuMs(process.cpuUsage(burstCpu))

      await new Promise(resolve => setTimeout(resolve, 200))
      const deliveredEvents = counters.reduce((sum, c) => sum + c.events, 0)
      const census: Record<string, number> = {}
      for (const counter of counters) {
        for (const [type, count] of Object.entries(counter.byType)) census[type] = (census[type] ?? 0) + count
      }
      if (streams > 0) console.log(`[host-fanout] streams=${String(streams)} frame census ${JSON.stringify(census)}`)
      const totalMs = performance.now() - burstStart

      for (const abort of aborts) abort.abort()
      await Promise.all(drains)

      // Every stream must still see every burst event: a cheaper run that
      // dropped frames is a regression, not a win.
      expect(deliveredEvents).toBe(emitted * streams)
      expect(baselineFrames).toBeGreaterThanOrEqual(streams * CATALOG_SESSIONS)
      if (streams === 0) baseEmitMs = emitMs

      report.push({
        streams,
        emitted,
        openMs: rounded(openMs),
        openCpuMs: rounded(openCpuMs),
        openMsPerStream: rounded(openMs / streams),
        emitMs: rounded(emitMs),
        emitCpuMs: rounded(emitCpuMs),
        fanoutMs: rounded(emitMs - baseEmitMs),
        fanoutUsPerEventPerStream: streams === 0 ? 0 : rounded((emitMs - baseEmitMs) * 1000 / (emitted * streams)),
        deliverMs: rounded(totalMs),
      })
    }

    console.log(`[host-fanout] seed ${rounded(seedMs)}ms for ${String(CATALOG_SESSIONS + 1)} sessions, long session ${String(long.events.length)} events`)
    console.table(report)
  })
})

/** Sum user and system microseconds into milliseconds. */
function cpuMs(usage: NodeJS.CpuUsage): number {
  return (usage.user + usage.system) / 1000
}
