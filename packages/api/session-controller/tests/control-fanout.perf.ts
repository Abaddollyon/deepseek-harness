/**
 * Opt-in host-side benchmark for Session control fan-out cost: how much CPU
 * the Host spends turning one Session's projection churn into frames for N
 * connected SessionControlController consumers, and what one control-stream
 * generation costs against a large Session catalog.
 *
 * It reports measurements without timing assertions (host speed is not a
 * correctness contract); structural assertions keep every consumer's delivered
 * state complete, latest, and identically scaled, so a "faster" run that
 * stopped delivering frames fails instead of scoring well.
 */
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SessionControlController } from '../src/control.ts'
import { ApiSessionList, DEFAULT_COLD_BLANK_PROBE_MAX_BYTES } from '../src/list.ts'
import type { SessionControlFrame } from '@deepseek-ai/dsh-api-session-controller/types'

// The real deployment this benchmark models: ~1560 sessions in the catalog and
// one conversation of ~1724 events. Consumer counts bracket a single browser
// tab against a handful of tabs/windows on the same host.
const CATALOG_SESSIONS = 1_560
const LONG_SESSION_EVENTS = 1_724
const CONSUMER_COUNTS = [0, 1, 2, 4, 8] as const
// `blocked` and `paced` bracket every possible queue-policy effect: no drain
// between appends at all, versus a drain after every turn.
const MODES = ['blocked', 'paced'] as const
const BURST_TURNS = 200

type Mode = (typeof MODES)[number]

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  // Token-meter's three wire units plus the gateway-owned list-metadata unit
  // are what a real deployment's projection churn looks like: whole-value
  // snapshots recomputed across a turn's events.
  await ctx.plugin(TokenMeter)
  return ctx
}

/** Register a live Agent so the control baseline's per-session lookups hit. */
function attachAgent(ctx: Context, session: Session): void {
  ctx.agents.register({
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
  } as Agent)
}

/** One user prompt: the event whose projection churn starts a turn. */
function appendUser(session: Session, turn: number): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `prompt ${String(turn)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** One assistant reply with usage: the event the token-meter units reprice on. */
function appendAssistant(session: Session, turn: number, step: number): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `turn ${String(turn)} step ${String(step)} body` }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
    usage: { inputTokens: 1_000 + turn, outputTokens: 100 + step },
  }, { surfaceOp: 'append' })
}

/** One full request header, the log-only envelope the breakdown unit reprices. */
function appendHeader(session: Session): void {
  session.append('request/header', {
    header: { config: { provider: 'p', model: 'm' } },
    reason: 'initial',
  })
}

/** The five events of one benchmark turn, in commit order. */
function turnAppends(session: Session, turn: number): (() => void)[] {
  return [
    () => { session.append('turn/start', { turn }) },
    () => { appendUser(session, turn) },
    () => { appendHeader(session) },
    () => { appendAssistant(session, turn, 1) },
    () => { session.append('turn/end', { turn, reason: { kind: 'completed' } }) },
  ]
}

/** Grow one session to roughly `target` events. */
function growSession(session: Session, target: number): void {
  let turn = 0
  while (session.events.length < target) {
    turn += 1
    for (const append of turnAppends(session, turn)) append()
  }
}

/**
 * Emit the measured burst and return how many events reached the log.
 *
 * `paced` models the streaming agent loop, which yields between committed
 * events so every open stream drains before the next append; `blocked` models
 * a host whose event loop is busy (a long synchronous query, a stalled
 * consumer), where frames pile up in the queue. The two bracket what any queue
 * policy can possibly save.
 */
async function emitBurst(session: Session, turns: number, mode: Mode): Promise<number> {
  const before = session.events.length
  for (let turn = 10_000; turn < 10_000 + turns; turn += 1) {
    for (const append of turnAppends(session, turn)) {
      append()
      if (mode === 'paced') await macrotask()
    }
  }
  return session.events.length - before
}

/** Yield to the macrotask queue, letting every open stream drain its buffer. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** Pushed projection changes per key, as the registry broadcast them. */
interface PushCensus {
  count: number
  lastSeq: number
  lastValue: unknown
}

/** Delivered control traffic for one consumer. */
interface Counter {
  baselines: number
  baselineProjections: number
  frames: number
  bytes: number
  serializeMs: number
  sequence: SessionControlFrame[]
  projections: Map<string, { count: number; lastSeq: number; lastValue: unknown }>
  /** Keys whose delivered seqs regressed — must stay empty. */
  monotonicViolations: string[]
}

function newCounter(): Counter {
  return {
    baselines: 0,
    baselineProjections: 0,
    frames: 0,
    bytes: 0,
    serializeMs: 0,
    sequence: [],
    projections: new Map(),
    monotonicViolations: [],
  }
}

/** Drain one control stream into a counter until the abort signal ends it. */
function drain(stream: AsyncIterable<SessionControlFrame>, counter: Counter): Promise<void> {
  return (async () => {
    for await (const frame of stream) {
      counter.frames += 1
      counter.sequence.push(frame)
      if (frame.type === 'baseline') {
        counter.baselines += 1
        counter.baselineProjections = Object.keys(frame.value.projections).length
      }
      if (frame.type === 'projection') {
        const row = counter.projections.get(frame.key)
          ?? { count: 0, lastSeq: -1, lastValue: undefined }
        if (frame.seq <= row.lastSeq && row.count > 0) counter.monotonicViolations.push(frame.key)
        row.count += 1
        row.lastSeq = frame.seq
        row.lastValue = frame.value
        counter.projections.set(frame.key, row)
      }
      // The Remote stream transport serializes each delivered frame per
      // consumer; that is the per-frame delivery cost a dropped frame removes,
      // so price it here.
      const started = performance.now()
      counter.bytes += JSON.stringify(frame).length
      counter.serializeMs += performance.now() - started
    }
  })()
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

/** Sum user and system microseconds into milliseconds. */
function cpuMs(usage: NodeJS.CpuUsage): number {
  return (usage.user + usage.system) / 1000
}

describe('manual host performance: Session control fan-out', () => {
  it('reports per-consumer open cost and per-event fan-out cost', async () => {
    const ctx = await harness()
    const control = new SessionControlController(ctx)
    new ApiSessionList(ctx, DEFAULT_COLD_BLANK_PROBE_MAX_BYTES)
    // The controllers' inject children activate asynchronously; yield until
    // their subscriptions land before any append.
    await macrotask()

    const catalogStart = performance.now()
    for (let index = 0; index < CATALOG_SESSIONS; index += 1) ctx.sessions.create()
    const long = ctx.sessions.create()
    attachAgent(ctx, long)
    growSession(long, LONG_SESSION_EVENTS)
    const seedMs = performance.now() - catalogStart
    const longEvents = long.events.length

    expect(ctx.sessions.list()).toHaveLength(CATALOG_SESSIONS + 1)
    expect(longEvents).toBeGreaterThanOrEqual(LONG_SESSION_EVENTS)

    const report: Record<string, unknown>[] = []
    // The 0-consumer row prices session.append itself, so every later row's
    // marginal column is fan-out cost alone rather than logging cost.
    const baseEmitMs: Partial<Record<Mode, number>> = {}
    for (const mode of MODES) for (const consumers of CONSUMER_COUNTS) {
      // Count exactly what the registry broadcast during this row's burst;
      // consumer assertions below are written against this census, not
      // against which units happen to fire.
      const census = new Map<string, PushCensus>()
      const unsubscribe = ctx.sessionProjections.onChanged((session, key, value, seq) => {
        if (session !== long) return
        const row = census.get(key) ?? { count: 0, lastSeq: -1, lastValue: undefined }
        row.count += 1
        row.lastSeq = seq
        row.lastValue = value
        census.set(key, row)
      })

      const aborts: AbortController[] = []
      const counters: Counter[] = []
      const drains: Promise<void>[] = []

      const openStart = performance.now()
      const openCpu = process.cpuUsage()
      for (let index = 0; index < consumers; index += 1) {
        const abort = new AbortController()
        aborts.push(abort)
        const counter = newCounter()
        counters.push(counter)
        drains.push(drain(control.control(abort.signal), counter))
      }
      // Let every generation's baseline land so the burst measures
      // steady-state fan-out.
      await new Promise(resolve => setTimeout(resolve, 50))
      const openMs = performance.now() - openStart
      const openCpuMs = cpuMs(process.cpuUsage(openCpu))

      const burstStart = performance.now()
      const burstCpu = process.cpuUsage()
      const emitted = await emitBurst(long, BURST_TURNS, mode)
      const emitMs = performance.now() - burstStart
      const emitCpuMs = cpuMs(process.cpuUsage(burstCpu))

      await new Promise(resolve => setTimeout(resolve, 200))
      unsubscribe()

      for (const abort of aborts) abort.abort()
      await Promise.all(drains)

      // Every consumer opened exactly one complete generation.
      for (const counter of counters) {
        expect(counter.baselines).toBe(1)
        expect(counter.baselineProjections).toBe(CATALOG_SESSIONS + 1)
        expect(counter.monotonicViolations).toEqual([])
      }
      // The production units actually churned: a run whose burst produced no
      // projection traffic measures nothing.
      expect(census.has('tokenUsage')).toBe(true)
      expect(census.has('contextBreakdown')).toBe(true)
      const keys = [...census.keys()].sort()
      for (const counter of counters) {
        expect([...counter.projections.keys()].sort()).toEqual(keys)
        for (const [key, pushed] of census) {
          const delivered = counter.projections.get(key)
          if (delivered === undefined) throw new Error(`consumer missed key ${key}`)
          // The latest complete projection is never lost, whatever the mode.
          expect(delivered.lastSeq).toBe(pushed.lastSeq)
          expect(delivered.lastValue).toEqual(pushed.lastValue)
          if (mode === 'paced') {
            // A drained queue coalesces nothing: every pushed frame arrived.
            expect(delivered.count).toBe(pushed.count)
          } else {
            // A blocked queue delivers exactly the newest frame per key.
            expect(delivered.count).toBe(1)
          }
        }
      }
      // Every consumer received the same baseline and exact frame sequence.
      for (let index = 1; index < counters.length; index += 1) {
        expect(counters[index]?.sequence).toEqual(counters[0]?.sequence)
      }

      const pushedTotal = [...census.values()].reduce((sum, row) => sum + row.count, 0)
      const deliveredTotal = counters.reduce((sum, counter) => sum + counter.frames, 0)
      if (consumers === 0) baseEmitMs[mode] = emitMs
      const fanoutMs = emitMs - (baseEmitMs[mode] ?? 0)
      if (consumers > 0) {
        console.log(`[host-control-fanout] ${mode} consumers=${String(consumers)} pushed ${String(pushedTotal)} projection frames across ${String(keys.length)} keys`)
      }

      report.push({
        mode,
        consumers,
        emitted,
        pushed: pushedTotal,
        delivered: deliveredTotal - counters.reduce((sum, counter) => sum + counter.baselines, 0),
        serializeMs: rounded(counters.reduce((sum, counter) => sum + counter.serializeMs, 0)),
        kb: Math.round(counters.reduce((sum, counter) => sum + counter.bytes, 0) / 1024),
        openMs: rounded(openMs),
        openCpuMs: rounded(openCpuMs),
        openMsPerConsumer: consumers === 0 ? 0 : rounded(openMs / consumers),
        emitMs: rounded(emitMs),
        emitCpuMs: rounded(emitCpuMs),
        fanoutMs: rounded(fanoutMs),
        fanoutUsPerEventPerConsumer: consumers === 0 ? 0 : rounded(fanoutMs * 1000 / (emitted * consumers)),
      })
    }

    console.log(`[host-control-fanout] seed ${String(rounded(seedMs))}ms for ${String(CATALOG_SESSIONS + 1)} sessions, long session ${String(longEvents)} events`)
    console.table(report)
  })
})
