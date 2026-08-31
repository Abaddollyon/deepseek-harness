import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionPreparation, UserMessage } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobOutcome, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { JobId, JOB_ADOPTION_ACCOUNT_REJECTED_DETAIL, PROCESS_INCARNATION } from '@deepseek-ai/dsh-jobs'
import type { JobRecord, JobStore } from '@deepseek-ai/dsh-jobs-store-domain'
import LocalJobRegistry, { type Config as JobsConfig } from '@deepseek-ai/dsh-jobs-local'
import RunSupervisor, {
  DETAIL_NOT_RESUMABLE,
  DETAIL_OWNER_UNAVAILABLE,
  DETAIL_RECONCILE_TIMEOUT,
  DETAIL_RESUME_CAP,
  REGISTRY_NOT_RESUMABLE_DETAIL,
  type Config as SupervisorConfig,
} from '@deepseek-ai/dsh-run-supervisor'

/**
 * Flush every pending microtask generation. All reconciliation flows here are
 * microtask-chained (fiber starts, promise continuations, queueMicrotask), so
 * this works under fake timers, where a setTimeout-based flush would hang.
 */
async function flush(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

const resumePlan = (start: () => JobHooks) => ({ start })

/** In-memory JobStore double shared across "reboots" through its record map. */
function fakeStore(records: Map<string, JobRecord> = new Map()) {
  const state = { records, deletes: [] as string[], failDeletes: false }
  const store = {
    incarnation: PROCESS_INCARNATION,
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    put: (record: JobRecord): Promise<void> => {
      records.set(record.id, record)
      return Promise.resolve()
    },
    delete: (id: string): Promise<boolean> => {
      if (state.failDeletes) return Promise.reject(new Error('injected delete failure'))
      state.deletes.push(id)
      return Promise.resolve(records.delete(id))
    },
  } as unknown as JobStore
  return { store, state }
}

/** One persisted record shaped like a previous process incarnation wrote it. */
function storedRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: JobId(`bash-${randomUUID()}`),
    kind: 'bash',
    label: 'restored job',
    ownerSession: SessionId('alice'),
    status: 'running',
    detail: null,
    output: null,
    startedAt: 100,
    finishedAt: null,
    reported: false,
    outputLimitBytes: null,
    resumeSpec: null,
    incarnation: 'prior-incarnation',
    schemaVersion: 1,
    ...overrides,
  }
}

interface FakePersistence {
  logs: Map<string, SessionEvent[]>
  appended: { id: string; events: readonly SessionEvent[] }[]
  prepareError?: Error
  prepareNever?: boolean
  appendError?: Error
  onAppend?: () => void
  /** Gate the append's completion, holding the run/* account unconfirmed. */
  appendWait?: () => Promise<void>
  listError?: Error
}

/** SessionPersistence double over in-memory durable logs. */
function fakePersistence(fake: FakePersistence) {
  const logs = fake.logs
  return {
    supportsRawArtifacts: false,
    locate: () => undefined,
    create: () => Promise.resolve(),
    prepare: (id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> => {
      if (fake.prepareNever) {
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
      }
      if (fake.prepareError !== undefined) return Promise.reject(fake.prepareError)
      if (!logs.has(id)) return Promise.reject(new Error(`no such session ${id}`))
      const preparation = {
        session: undefined,
        [Symbol.dispose]: () => {},
      } as unknown as SessionPreparation
      return Promise.resolve(preparation)
    },
    inspect: (id: SessionId) => {
      if (!logs.has(id)) return Promise.reject(new Error(`no such session ${id}`))
      return Promise.resolve({ meta: { id }, events: logs.get(id) ?? [] })
    },
    load: (id: SessionId) => {
      if (!logs.has(id)) return Promise.reject(new Error(`no such session ${id}`))
      return Promise.resolve({ meta: { id }, events: logs.get(id) ?? [] })
    },
    append: async (id: SessionId, events: readonly SessionEvent[]) => {
      fake.onAppend?.()
      if (fake.appendWait !== undefined) await fake.appendWait()
      if (fake.appendError !== undefined) return Promise.reject(fake.appendError)
      if (!logs.has(id)) return Promise.reject(new Error(`no such session ${id}`))
      const log = logs.get(id) as SessionEvent[]
      const cursor = log.length
      events.forEach((event, index) => {
        if (event.seq !== cursor + index) throw new Error(`append seq mismatch: expected ${cursor + index}, got ${event.seq}`)
      })
      log.push(...events.map(event => structuredClone(event)))
      fake.appended.push({ id, events })
      return Promise.resolve()
    },
    list: () => {
      if (fake.listError !== undefined) return Promise.reject(fake.listError)
      return Promise.resolve([...logs.keys()].map(id => ({ id: SessionId(id) })))
    },
  }
}

interface StubAgent {
  agent: Agent
  injected: UserMessage[]
}

function stubAgent(ctx: Context, rawId: string): StubAgent {
  const id = SessionId(rawId)
  const session = Session.create(id)
  const injected: UserMessage[] = []
  const agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle' as const,
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: (message: UserMessage) => { injected.push(message) },
    cancel: () => {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  return { agent, injected }
}

interface BootOptions {
  records?: JobRecord[]
  store?: ReturnType<typeof fakeStore>
  jobsConfig?: JobsConfig
  config?: SupervisorConfig
  persistence?: ReturnType<typeof fakePersistence> | undefined
  liveAgents?: string[]
  liveEvents?: Record<string, SessionEvent[]>
}

/** Boot a persisting registry over one store, then the supervisor over both. */
async function boot(options: BootOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const { store, state } = options.store ?? fakeStore(new Map((options.records ?? []).map(r => [String(r.id), r])))
  ctx.provide('jobStore', store)
  if (options.persistence !== undefined) {
    ctx.provide('sessionPersistence', options.persistence as unknown as never)
  }
  // A short teardown grace keeps unsettled-test cleanup fast; production
  // defaults are asserted by the config schema, not by this harness.
  await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20, ...options.jobsConfig })
  ctx.jobs.attachController('test-controller')
  await flush()
  const agents = new Map<string, StubAgent>()
  for (const id of options.liveAgents ?? []) {
    const stub = stubAgent(ctx, id)
    for (const event of options.liveEvents?.[id] ?? []) {
      (stub.agent.session.append as unknown as (type: string, data: unknown) => void)(event.type, event.data)
    }
    ctx.agents.register(stub.agent)
    agents.set(id, stub)
  }
  await ctx.plugin(RunSupervisor, options.config ?? {})
  await flush()
  return { ctx, store, state, agents }
}

const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
})

function tracked<T extends { ctx: Context }>(booted: T): T {
  contexts.push(booted.ctx)
  return booted
}

function runEvents(session: Session, type: string): SessionEvent[] {
  return session.events.filter(event => event.type === type)
}

/** Registry view through the session fence; falls back to the durable mirror. */
function jobView(ctx: Context, state: { records: Map<string, JobRecord> }, record: JobRecord, owner?: Agent): JobSnapshot | JobRecord {
  if (owner !== undefined) return ctx.jobs.get(record.id, owner)
  const stored = state.records.get(String(record.id))
  if (stored === undefined) throw new Error(`missing stored record ${record.id}`)
  return stored
}

describe('RunSupervisor boot accounting of restore-settled records', () => {
  it('accounts a not-resumable record: run/abandoned plus exactly one notice when reported was false', async () => {
    const record = storedRecord({ resumeSpec: null, reported: false })
    const { ctx, state, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    // jobs-local already honest-settled the record at restore; the supervisor
    // accounts for that settlement without inventing a second terminal state.
    expect(jobView(ctx, state, record, alice.agent)).toMatchObject({
      status: 'failed',
      detail: REGISTRY_NOT_RESUMABLE_DETAIL,
    })

    const abandoned = runEvents(alice.agent.session, 'run/abandoned')
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.data).toMatchObject({
      jobId: record.id,
      kind: 'bash',
      reason: 'not-resumable',
      detail: DETAIL_NOT_RESUMABLE,
    })

    expect(alice.injected).toHaveLength(1)
    const notice = alice.injected[0] as UserMessage
    expect(notice.source).toMatchObject({ kind: 'plugin', plugin: 'run-supervisor', form: 'notice' })
    const text = (notice.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain(`background job ${record.id}`)
    expect(text).toContain(`[status: failed, ${DETAIL_NOT_RESUMABLE}]`)

    // The delivered notice claims the terminal report, persisted for the next boot.
    expect(ctx.jobs.get(record.id, alice.agent).reported).toBe(true)
    expect(state.records.get(String(record.id))?.reported).toBe(true)
  })

  it('delivers an unread terminal record that settled before this host', async () => {
    const record = storedRecord({
      status: 'completed', finishedAt: Date.now(), reported: false, detail: null,
      outputLimitBytes: 256,
    })
    const defaultRetention = storedRecord({
      ownerSession: SessionId('bob'), status: 'completed', finishedAt: Date.now(),
      reported: false, outputLimitBytes: null,
    })
    const unowned = storedRecord({
      ownerSession: null, status: 'failed', finishedAt: Date.now(), reported: false,
    })
    const { ctx, agents, state } = tracked(await boot({
      records: [record, defaultRetention, unowned], liveAgents: ['alice', 'bob'],
    }))
    const alice = agents.get('alice') as StubAgent
    expect(alice.injected).toHaveLength(1)
    expect((alice.injected[0]?.content[0] as { type: 'text'; text: string }).text)
      .toContain('[status: completed]')
    expect(ctx.jobs.get(record.id, alice.agent).reported).toBe(true)
    expect((agents.get('bob') as StubAgent).injected).toHaveLength(1)
    expect(state.records.get(unowned.id)?.reported).toBe(false)
  })

  it('delivers zero notices and no event when reported was already true', async () => {
    const record = storedRecord({ status: 'stopping', resumeSpec: null, reported: true })
    const { state, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    expect(jobView({} as Context, state, record)).toMatchObject({ status: 'killed' })
    expect(runEvents(alice.agent.session, 'run/abandoned')).toHaveLength(0)
    expect(alice.injected).toHaveLength(0)
  })

  it('appends run/abandoned offline for a restorable owner and never re-appends on a later boot', async () => {
    const logs = new Map<string, SessionEvent[]>([['bob', []]])
    const persistence = fakePersistence({ logs, appended: [] })
    const records = new Map<string, JobRecord>()
    const record = storedRecord({ ownerSession: SessionId('bob'), resumeSpec: null })
    records.set(String(record.id), record)
    const shared = fakeStore(records)

    const first = tracked(await boot({ store: shared, persistence }))
    expect(jobView(first.ctx, shared.state, record)).toMatchObject({ status: 'failed' })
    expect(logs.get('bob')).toHaveLength(1)
    expect(logs.get('bob')?.[0]).toMatchObject({
      type: 'run/abandoned',
      seq: 0,
      data: { jobId: record.id, kind: 'bash', reason: 'not-resumable', detail: DETAIL_NOT_RESUMABLE },
    })
    // No live agent and no live lane: the record stays unreported until the
    // owner collects it, but the durable account must not duplicate.
    await first.ctx.fiber.dispose()
    contexts.pop()

    const second = tracked(await boot({ store: shared, persistence }))
    expect(jobView(second.ctx, shared.state, record)).toMatchObject({ status: 'failed' })
    expect(logs.get('bob')).toHaveLength(1)
  })

  it('accounts a resumer decline at restore as resume-failed with the record detail', async () => {
    const logs = new Map<string, SessionEvent[]>([['carol', []]])
    const persistence = fakePersistence({ logs, appended: [] })
    const record = storedRecord({ ownerSession: SessionId('carol'), resumeSpec: { cmd: 'rerun' } })
    const shared = fakeStore(new Map([[String(record.id), record]]))

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    // The producer resumer registers before the store adopts, so the restore
    // replay itself declines the record.
    ctx.jobs.registerResumer('bash', () => undefined)
    ctx.provide('jobStore', shared.store)
    ctx.provide('sessionPersistence', persistence as unknown as never)
    await flush()
    expect(shared.state.records.get(String(record.id))?.status).toBe('failed')

    await ctx.plugin(RunSupervisor, {})
    await flush()
    expect(logs.get('carol')).toHaveLength(1)
    expect(logs.get('carol')?.[0]?.data).toMatchObject({
      jobId: record.id,
      reason: 'resume-failed',
      detail: REGISTRY_NOT_RESUMABLE_DETAIL,
    })
  })

  it('accounts a throwing resumer at restore as resume-failed with the thrown detail', async () => {
    const logs = new Map<string, SessionEvent[]>([['carol', []]])
    const persistence = fakePersistence({ logs, appended: [] })
    const record = storedRecord({ ownerSession: SessionId('carol'), resumeSpec: { cmd: 'rerun' } })
    const shared = fakeStore(new Map([[String(record.id), record]]))

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    ctx.jobs.registerResumer('bash', () => { throw new Error('resume boom') })
    ctx.provide('jobStore', shared.store)
    ctx.provide('sessionPersistence', persistence as unknown as never)
    await flush()

    await ctx.plugin(RunSupervisor, {})
    await flush()
    expect(logs.get('carol')).toHaveLength(1)
    expect(logs.get('carol')?.[0]?.data).toMatchObject({
      jobId: record.id,
      reason: 'resume-failed',
      detail: 'resume handler threw: Error: resume boom',
    })
  })

  it('skips lane-settled records with no owning session', async () => {
    const record = storedRecord({ ownerSession: null, resumeSpec: null })
    const { ctx } = tracked(await boot({ records: [record] }))
    // Restore settled it; with no owner session there is no log to account into.
    expect(ctx.jobs.get(record.id).status).toBe('failed')
  })
})

describe('RunSupervisor pending-record reconciliation', () => {
  it('honest-settles a pending record whose owner cannot be restored', async () => {
    const logs = new Map<string, SessionEvent[]>([['dan', []]])
    // prepare fails (the resume path cannot restore dan) while inspect still
    // exposes the durable log for the offline account.
    const persistence = fakePersistence({ logs, appended: [], prepareError: new Error('corrupt log') })
    const record = storedRecord({ ownerSession: SessionId('dan'), resumeSpec: { cmd: 'rerun' } })
    const { state } = tracked(await boot({ records: [record], persistence }))

    expect(jobView({} as Context, state, record)).toMatchObject({ status: 'failed', detail: REGISTRY_NOT_RESUMABLE_DETAIL })
    expect(logs.get('dan')).toHaveLength(1)
    expect(logs.get('dan')?.[0]?.data).toMatchObject({
      jobId: record.id,
      reason: 'owner-unavailable',
      detail: DETAIL_OWNER_UNAVAILABLE,
    })
  })

  it('honest-settles adoptable records when the reconciliation deadline passes', async () => {
    vi.useFakeTimers()
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const { ctx, state, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    // Before the deadline the record waits for a producer resumer.
    expect(jobView(ctx, state, record, alice.agent).status).toBe('running')

    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(jobView(ctx, state, record, alice.agent)).toMatchObject({ status: 'failed', detail: REGISTRY_NOT_RESUMABLE_DETAIL })
    const abandoned = runEvents(alice.agent.session, 'run/abandoned')
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.data).toMatchObject({
      jobId: record.id,
      reason: 'reconcile-timeout',
      detail: DETAIL_RECONCILE_TIMEOUT,
    })
    expect(alice.injected).toHaveLength(1)
  })

  it('classifies an owner as unknown when the deadline aborts its restoration', async () => {
    vi.useFakeTimers()
    const logs = new Map<string, SessionEvent[]>([['erin', []]])
    const persistence = fakePersistence({ logs, appended: [], prepareNever: true })
    const record = storedRecord({ ownerSession: SessionId('erin'), resumeSpec: { cmd: 'rerun' } })
    const { state } = tracked(await boot({ records: [record], persistence, config: { bootResumeTimeoutMs: 500 } }))

    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    // The aborted prepare is not evidence about the owner: the record settles
    // with the deadline account, never an owner verdict.
    expect(jobView({} as Context, state, record).status).toBe('failed')
    expect(logs.get('erin')).toHaveLength(1)
    expect(logs.get('erin')?.[0]?.data).toMatchObject({ reason: 'reconcile-timeout', detail: DETAIL_RECONCILE_TIMEOUT })
  })

  it('caps adoptions per owner: the overflow honest-settles with the cap detail', async () => {
    vi.useFakeTimers()
    const first = storedRecord({ startedAt: 100, resumeSpec: { n: 1 } })
    const second = storedRecord({ startedAt: 200, resumeSpec: { n: 2 } })
    const { ctx, agents } = tracked(await boot({
      records: [first, second],
      liveAgents: ['alice'],
      config: { maxResumedRunsPerOwner: 1 },
    }))
    const alice = agents.get('alice') as StubAgent

    // The budget admits the older record; the overflow waits for the kind's
    // resolution rather than racing a resumer registration.
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(ctx.jobs.get(first.id, alice.agent).status).toBe('failed')
    expect(ctx.jobs.get(second.id, alice.agent).status).toBe('failed')
    const abandoned = runEvents(alice.agent.session, 'run/abandoned')
    expect(abandoned).toHaveLength(2)
    const byId = new Map(abandoned.map((event) => {
      const data = event.data as { jobId: JobId; reason: string; detail: string }
      return [String(data.jobId), data] as const
    }))
    expect(byId.get(String(first.id))).toMatchObject({ reason: 'reconcile-timeout', detail: DETAIL_RECONCILE_TIMEOUT })
    expect(byId.get(String(second.id))).toMatchObject({ reason: 'not-resumable', detail: DETAIL_RESUME_CAP })
  })

  it('breaks budget ties by id when two records share a startedAt', async () => {
    vi.useFakeTimers()
    const first = storedRecord({ startedAt: 100, resumeSpec: { n: 1 } })
    const second = storedRecord({ startedAt: 100, resumeSpec: { n: 2 } })
    const { ctx, agents } = tracked(await boot({
      records: [first, second],
      liveAgents: ['alice'],
      config: { maxResumedRunsPerOwner: 1 },
    }))
    const alice = agents.get('alice') as StubAgent
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(ctx.jobs.get(first.id, alice.agent).status).toBe('failed')
    expect(ctx.jobs.get(second.id, alice.agent).status).toBe('failed')
    const abandoned = runEvents(alice.agent.session, 'run/abandoned')
    expect(abandoned).toHaveLength(2)
    const details = new Set(abandoned.map(event => (event.data as { detail: string }).detail))
    expect(details).toEqual(new Set([DETAIL_RECONCILE_TIMEOUT, DETAIL_RESUME_CAP]))
  })

  it('stops classifying further owner groups once the deadline aborts the pass', async () => {
    vi.useFakeTimers()
    const logs = new Map<string, SessionEvent[]>([['erin', []], ['mia', []]])
    const persistence = fakePersistence({ logs, appended: [], prepareNever: true })
    const first = storedRecord({ ownerSession: SessionId('erin'), resumeSpec: { n: 1 } })
    const second = storedRecord({ ownerSession: SessionId('mia'), resumeSpec: { n: 2 } })
    const { state } = tracked(await boot({ records: [first, second], persistence, config: { bootResumeTimeoutMs: 500 } }))
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    // The first group's aborted restore is not an owner verdict; the second
    // group was never classified at all. Both settle with the deadline account.
    expect(jobView({} as Context, state, first).status).toBe('failed')
    expect(jobView({} as Context, state, second).status).toBe('failed')
    expect(logs.get('erin')?.[0]?.data).toMatchObject({ reason: 'reconcile-timeout' })
    expect(logs.get('mia')?.[0]?.data).toMatchObject({ reason: 'reconcile-timeout' })
  })

  it('adopts a pending record through a producer resumer and logs run/resumed', async () => {
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const { ctx, state, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    let settle!: (outcome: JobOutcome) => void
    const hooks: JobHooks = {
      cancel: () => {},
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      readOutput: () => '',
    }
    const resumer = vi.fn(() => resumePlan(() => hooks))
    ctx.jobs.registerResumer('bash', resumer)
    await flush()

    expect(resumer).toHaveBeenCalledWith(expect.objectContaining({
      id: record.id,
      resumeSpec: { cmd: 'rerun' },
      priorIncarnation: 'prior-incarnation',
    }))
    expect(ctx.jobs.get(record.id, alice.agent)).toMatchObject({ status: 'running', incarnation: PROCESS_INCARNATION })
    const resumed = runEvents(alice.agent.session, 'run/resumed')
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.data).toMatchObject({ jobId: record.id, kind: 'bash', priorIncarnation: 'prior-incarnation' })

    // The resumed run's completion reaches the owner exactly once.
    settle({ status: 'completed', detail: 'done', output: 'final' })
    await flush()
    expect(alice.injected).toHaveLength(1)
    const text = (alice.injected[0]?.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('[status: completed, done]')
    expect(state.records.get(String(record.id))?.reported).toBe(true)
  })

  it('an already-resolved done settles completed after the account, never abandoned', async () => {
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const { ctx, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    // The producer's done is settled before the resumer even returns it; the
    // adoption account must still land first so the completion classifies as
    // a resumed run finishing, never as a failed resume.
    ctx.jobs.registerResumer('bash', () => resumePlan(() => ({
      cancel: () => {},
      done: Promise.resolve<JobOutcome>({ status: 'completed', detail: 'instant', output: 'final' }),
    })))
    await flush()

    expect(ctx.jobs.get(record.id, alice.agent)).toMatchObject({ status: 'completed', detail: 'instant' })
    expect(runEvents(alice.agent.session, 'run/resumed')).toHaveLength(1)
    expect(runEvents(alice.agent.session, 'run/abandoned')).toHaveLength(0)
    expect(alice.injected).toHaveLength(1)
    const text = (alice.injected[0]?.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('[status: completed, instant]')
  })

  it('delivers no notice for an adopted record the owner killed', async () => {
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const { ctx, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.registerResumer('bash', () => resumePlan(() => ({
      cancel: () => { settle({ status: 'killed', detail: 'killed by owner' }) },
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    })))
    await flush()
    expect(ctx.jobs.get(record.id, alice.agent).status).toBe('running')

    // A kill through the job tools marks the record reported, so its
    // settlement owes the owner no notice.
    expect(ctx.jobs.kill(record.id, alice.agent, 'no longer needed')).toBe('requested')
    await flush()
    expect(ctx.jobs.get(record.id, alice.agent).status).toBe('killed')
    expect(runEvents(alice.agent.session, 'run/resumed')).toHaveLength(1)
    expect(alice.injected).toHaveLength(0)
  })

  it('accounts a producer decline as resume-failed and tolerates its own duplicate registration', async () => {
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const { ctx, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    // The producer resumer wins the kind; the supervisor's settlement lane
    // for that kind collides with the duplicate registration and steps aside.
    ctx.jobs.registerResumer('bash', () => undefined)
    await flush()
    expect(ctx.jobs.get(record.id, alice.agent)).toMatchObject({ status: 'failed', detail: REGISTRY_NOT_RESUMABLE_DETAIL })
    const abandoned = runEvents(alice.agent.session, 'run/abandoned')
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.data).toMatchObject({ reason: 'resume-failed', detail: REGISTRY_NOT_RESUMABLE_DETAIL })
  })

  it('settles every pending record immediately when resumeOnBoot is false', async () => {
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const { ctx, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'], config: { resumeOnBoot: false } }))
    const alice = agents.get('alice') as StubAgent

    expect(ctx.jobs.get(record.id, alice.agent).status).toBe('failed')
    const abandoned = runEvents(alice.agent.session, 'run/abandoned')
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.data).toMatchObject({ reason: 'not-resumable', detail: DETAIL_NOT_RESUMABLE })
  })

  it('leaves same-incarnation records untouched (in-process reload safety)', async () => {
    const record = storedRecord({ incarnation: PROCESS_INCARNATION, resumeSpec: { keep: true } })
    const { ctx, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'], config: { bootResumeTimeoutMs: 50 } }))
    const alice = agents.get('alice') as StubAgent
    await new Promise<void>(r => setTimeout(r, 120))
    await flush()

    expect(ctx.jobs.get(record.id, alice.agent)).toMatchObject({ status: 'running', incarnation: PROCESS_INCARNATION })
    expect(runEvents(alice.agent.session, 'run/abandoned')).toHaveLength(0)
    expect(runEvents(alice.agent.session, 'run/resumed')).toHaveLength(0)
    expect(alice.injected).toHaveLength(0)
  })

  it('treats a kill while awaiting resume as an owner action, not an abandonment', async () => {
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const { ctx, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    expect(ctx.jobs.kill(record.id, alice.agent, 'no longer needed')).toBe('requested')
    await flush()
    expect(ctx.jobs.get(record.id, alice.agent)).toMatchObject({ status: 'killed', detail: 'no longer needed' })
    expect(runEvents(alice.agent.session, 'run/abandoned')).toHaveLength(0)
    expect(alice.injected).toHaveLength(0)
  })

  it('suppresses the notice when a waiter already observed the settlement', async () => {
    vi.useFakeTimers()
    const pending = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const { ctx, agents } = tracked(await boot({ records: [pending], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    const waited = ctx.jobs.wait(pending.id, 60_000, alice.agent)
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    const snapshot = await waited
    expect(snapshot.status).toBe('failed')
    expect(snapshot.reported).toBe(true)
    expect(alice.injected).toHaveLength(0)
    const abandoned = runEvents(alice.agent.session, 'run/abandoned')
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.data).toMatchObject({ reason: 'reconcile-timeout' })
  })

  it('adopts an unowned record without session events', async () => {
    const record = storedRecord({ ownerSession: null, resumeSpec: { cmd: 'rerun' } })
    const { ctx } = tracked(await boot({ records: [record] }))
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.registerResumer('bash', () => resumePlan(() => ({
      cancel: () => {},
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    })))
    await flush()
    expect(ctx.jobs.get(record.id)).toMatchObject({ status: 'running', incarnation: PROCESS_INCARNATION })
    settle({ status: 'completed' })
    await flush()
    expect(ctx.jobs.get(record.id).status).toBe('completed')
  })

  it('settles a stopping resumable record like a running one', async () => {
    vi.useFakeTimers()
    const record = storedRecord({ status: 'stopping', resumeSpec: { cmd: 'rerun' } })
    const { ctx, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(ctx.jobs.get(record.id, alice.agent).status).toBe('killed')
    expect(runEvents(alice.agent.session, 'run/abandoned')).toHaveLength(0)
  })
})

describe('RunSupervisor durable adoption markers', () => {
  it('accounts a pre-supervisor adoption marker as run/resumed and clears it durably', async () => {
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const shared = fakeStore(new Map([[String(record.id), record]]))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', shared.store)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()
    const alice = stubAgent(ctx, 'alice')
    ctx.agents.register(alice.agent)

    // The producer resumer adopts before the supervisor mounts: the registry
    // commits the re-stamped record carrying the adoption marker, and no
    // supervisor observer saw the adoption.
    ctx.jobs.registerResumer('bash', () => resumePlan(() => ({
      cancel: () => {},
      done: new Promise<JobOutcome>(() => {}),
    })))
    await flush()
    expect(shared.state.records.get(String(record.id))).toMatchObject({
      status: 'running',
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })
    expect(runEvents(alice.agent.session, 'run/resumed')).toHaveLength(0)

    await ctx.plugin(RunSupervisor, {})
    await flush()

    const resumed = runEvents(alice.agent.session, 'run/resumed')
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.data).toMatchObject({ jobId: record.id, kind: 'bash', priorIncarnation: 'prior-incarnation' })
    const cleared = shared.state.records.get(String(record.id)) as JobRecord
    expect(cleared).toMatchObject({ status: 'running', incarnation: PROCESS_INCARNATION })
    expect('adoptedFromIncarnation' in cleared).toBe(false)
    await flush()
    expect(runEvents(alice.agent.session, 'run/resumed')).toHaveLength(1)
  })

  it('reports completion when a running adoption marker settles after supervisor mount', async () => {
    const done = Promise.withResolvers<JobOutcome>()
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const shared = fakeStore(new Map([[String(record.id), record]]))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', shared.store)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()
    const alice = stubAgent(ctx, 'alice')
    ctx.agents.register(alice.agent)
    ctx.jobs.registerResumer('bash', () => resumePlan(() => ({ cancel: () => {}, done: done.promise })))
    await flush()
    await ctx.plugin(RunSupervisor, {})
    await flush()
    shared.state.records.set(String(record.id), {
      ...shared.state.records.get(String(record.id)) as JobRecord,
      adoptedFromIncarnation: 'newer-adoption',
    })

    done.resolve({ status: 'completed', output: 'finished' })
    await flush()
    expect(alice.injected).toHaveLength(1)
    expect(shared.state.records.get(String(record.id))).toMatchObject({ status: 'completed', reported: true })
  })

  it('reports an already-terminal adoption marker before clearing its proof', async () => {
    const record = storedRecord({
      status: 'completed', finishedAt: 200, reported: false,
      incarnation: PROCESS_INCARNATION, adoptedFromIncarnation: 'prior-incarnation',
    })
    const { state, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent
    await flush()
    expect(runEvents(alice.agent.session, 'run/resumed')).toHaveLength(1)
    expect(alice.injected).toHaveLength(1)
    expect(state.records.get(String(record.id))).toMatchObject({ status: 'completed', reported: true })
    expect('adoptedFromIncarnation' in (state.records.get(String(record.id)) as JobRecord)).toBe(false)
  })

  it('keeps an accounted terminal marker completion pending when owner is offline', async () => {
    const record = storedRecord({
      status: 'completed', finishedAt: 200, reported: false,
      incarnation: PROCESS_INCARNATION, adoptedFromIncarnation: 'prior-incarnation',
    })
    const logs = new Map<string, SessionEvent[]>([['alice', []]])
    const persistence = fakePersistence({ logs, appended: [] })
    const { state } = tracked(await boot({ records: [record], persistence: persistence as unknown as never }))
    await flush()
    expect(state.records.get(String(record.id))).toMatchObject({ status: 'completed', reported: false })
  })

  it('clears a rejected adoption marker without claiming the producer resumed', async () => {
    const record = storedRecord({
      status: 'failed',
      detail: JOB_ADOPTION_ACCOUNT_REJECTED_DETAIL,
      incarnation: 'rejecting-incarnation',
      adoptedFromIncarnation: 'prior-incarnation',
    })
    const first = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const firstAlice = first.agents.get('alice') as StubAgent
    expect(runEvents(firstAlice.agent.session, 'run/resumed')).toHaveLength(0)
    expect(runEvents(firstAlice.agent.session, 'run/abandoned')).toHaveLength(0)

    const second = tracked(await boot({
      records: [...first.state.records.values()],
      liveAgents: ['alice'],
    }))
    const secondAlice = second.agents.get('alice') as StubAgent
    expect(runEvents(secondAlice.agent.session, 'run/resumed')).toHaveLength(0)
    const cleared = second.state.records.get(String(record.id)) as JobRecord
    expect(cleared.status).toBe('failed')
    expect('adoptedFromIncarnation' in cleared).toBe(false)
  })

  it('accounts each adoption incarnation after a SIGKILLed boot', async () => {
    // A previous boot adopted the record and committed the marker, then died
    // before its supervisor accounted the adoption.
    const record = storedRecord({
      resumeSpec: { cmd: 'rerun' },
      incarnation: 'adopting-incarnation',
      adoptedFromIncarnation: 'original-incarnation',
    })
    const { ctx, state, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    const resumed = runEvents(alice.agent.session, 'run/resumed')
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.data).toMatchObject({ jobId: record.id, priorIncarnation: 'original-incarnation' })
    expect('adoptedFromIncarnation' in (state.records.get(String(record.id)) as JobRecord)).toBe(false)

    // This boot's re-adoption is a distinct ownership transfer from the
    // adopting incarnation and receives its own account.
    ctx.jobs.registerResumer('bash', () => resumePlan(() => ({
      cancel: () => {},
      done: new Promise<JobOutcome>(() => {}),
    })))
    await flush()
    expect(ctx.jobs.get(record.id, alice.agent)).toMatchObject({ status: 'running', incarnation: PROCESS_INCARNATION })
    const accounts = runEvents(alice.agent.session, 'run/resumed')
    expect(accounts).toHaveLength(2)
    expect(accounts[1]?.data).toMatchObject({ jobId: record.id, priorIncarnation: 'adopting-incarnation' })
  })

  it('clears a stopping unowned record\'s marker without session events', async () => {
    const record = storedRecord({
      ownerSession: null,
      status: 'stopping',
      resumeSpec: { cmd: 'rerun' },
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })
    const { state } = tracked(await boot({ records: [record] }))

    const cleared = state.records.get(String(record.id)) as JobRecord
    expect(cleared).toMatchObject({ status: 'killed', incarnation: PROCESS_INCARNATION })
    expect('adoptedFromIncarnation' in cleared).toBe(false)
  })

  it('accounts and clears a terminal record adoption marker', async () => {
    // A terminal adoption marker still proves an ownership transfer that the
    // session log must account before the marker clears.
    const record = storedRecord({
      status: 'completed',
      finishedAt: 200,
      reported: true,
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })
    const { state, agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent

    const cleared = state.records.get(String(record.id)) as JobRecord
    expect(cleared.status).toBe('completed')
    expect('adoptedFromIncarnation' in cleared).toBe(false)
    expect(runEvents(alice.agent.session, 'run/resumed')).toHaveLength(1)
  })

  it('clears the marker only after the account append confirms: a blocked append holds it', async () => {
    const gate = Promise.withResolvers<undefined>()
    const logs = new Map<string, SessionEvent[]>([['judy', []]])
    const persistence = fakePersistence({ logs, appended: [], appendWait: () => gate.promise })
    const record = storedRecord({
      ownerSession: SessionId('judy'),
      resumeSpec: { cmd: 'rerun' },
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })
    const { state } = tracked(await boot({ records: [record], persistence: persistence as unknown as never }))
    await flush()

    // The pass is parked on the gated append: the account is unconfirmed, so
    // the marker must still be durable.
    expect(state.records.get(String(record.id))).toMatchObject({ adoptedFromIncarnation: 'prior-incarnation' })
    expect(logs.get('judy')).toHaveLength(0)

    gate.resolve(undefined)
    await flush()
    const cleared = state.records.get(String(record.id)) as JobRecord
    expect('adoptedFromIncarnation' in cleared).toBe(false)
    expect(logs.get('judy')).toHaveLength(1)
    expect(logs.get('judy')?.[0]).toMatchObject({
      type: 'run/resumed',
      data: { jobId: record.id, priorIncarnation: 'prior-incarnation' },
    })
  })

  it('clears the marker when the session came live mid-append already carrying the account', async () => {
    const record = storedRecord({
      ownerSession: SessionId('judy'),
      resumeSpec: { cmd: 'rerun' },
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })
    const logs = new Map<string, SessionEvent[]>([['judy', []]])
    const shared = fakeStore(new Map([[String(record.id), record]]))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', shared.store)
    const stub = stubAgent(ctx, 'judy')
    ;(stub.agent.session.append as unknown as (type: string, data: unknown) => void)('run/resumed', {
      jobId: record.id, kind: 'bash', priorIncarnation: 'prior-incarnation',
    })
    const persistence = fakePersistence({
      logs,
      appended: [],
      appendError: new Error('seq moved'),
      onAppend: () => {
        // The session came live between owner resolution and the offline append.
        if (ctx.agents.get(SessionId('judy')) === undefined) ctx.agents.register(stub.agent)
      },
    })
    ctx.provide('sessionPersistence', persistence as unknown as never)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()
    await ctx.plugin(RunSupervisor, {})
    await flush()

    // The live session already carried the account: the marker clears with
    // no duplicate event.
    expect('adoptedFromIncarnation' in (shared.state.records.get(String(record.id)) as JobRecord)).toBe(false)
    expect(runEvents(stub.agent.session, 'run/resumed')).toHaveLength(1)
  })

  it('retains the marker when no lane can reach the owner', async () => {
    const record = storedRecord({
      ownerSession: SessionId('ghost'),
      resumeSpec: { cmd: 'rerun' },
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })
    const { state } = tracked(await boot({ records: [record] }))

    expect(state.records.get(String(record.id))).toMatchObject({
      status: 'running',
      adoptedFromIncarnation: 'prior-incarnation',
    })
  })

  it('retains the marker and warns when the account append fails', async () => {
    // No durable log for judy: the offline lane's load rejects.
    const record = storedRecord({
      ownerSession: SessionId('judy'),
      resumeSpec: { cmd: 'rerun' },
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })
    const shared = fakeStore(new Map([[String(record.id), record]]))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', shared.store)
    ctx.provide('sessionPersistence', fakePersistence({ logs: new Map(), appended: [] }) as unknown as never)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await ctx.plugin(RunSupervisor, {})
    await flush()

    expect(shared.state.records.get(String(record.id))).toMatchObject({ adoptedFromIncarnation: 'prior-incarnation' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to record a reconciliation outcome'))
  })

  it('clears the marker without re-appending when the log already carries the account', async () => {
    const record = storedRecord({
      ownerSession: SessionId('judy'),
      resumeSpec: { cmd: 'rerun' },
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })
    const logs = new Map<string, SessionEvent[]>([['judy', [{
      type: 'run/resumed', seq: 0, time: 1,
      data: { jobId: record.id, kind: 'bash', priorIncarnation: 'prior-incarnation' },
    }]]])
    const fake: FakePersistence = { logs, appended: [] }
    const persistence = fakePersistence(fake)
    const { state } = tracked(await boot({ records: [record], persistence: persistence as unknown as never }))

    const cleared = state.records.get(String(record.id)) as JobRecord
    expect('adoptedFromIncarnation' in cleared).toBe(false)
    expect(fake.appended).toHaveLength(0)
    expect(logs.get('judy')).toHaveLength(1)
  })
})

describe('RunSupervisor orphan retention', () => {
  it('evicts expired terminal records whose owner is neither live nor listed', async () => {
    const finishedLongAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    const expired = storedRecord({
      ownerSession: SessionId('gone'),
      status: 'failed',
      detail: 'crashed',
      finishedAt: finishedLongAgo,
      reported: true,
    })
    const keptListed = storedRecord({
      ownerSession: SessionId('listed'),
      status: 'completed',
      finishedAt: finishedLongAgo,
      reported: true,
    })
    const keptRecent = storedRecord({
      ownerSession: SessionId('gone'),
      status: 'failed',
      finishedAt: Date.now(),
      reported: true,
    })
    // Unowned terminal records need no session-presence classification.
    const unownedExpired = storedRecord({
      ownerSession: null,
      status: 'failed',
      detail: 'crashed',
      finishedAt: finishedLongAgo,
      reported: true,
    })
    const unsettledTerminal = storedRecord({
      ownerSession: SessionId('gone'),
      status: 'completed',
      finishedAt: null,
      reported: true,
    })
    const logs = new Map<string, SessionEvent[]>([['listed', []]])
    const persistence = fakePersistence({ logs, appended: [] })
    const { state } = tracked(await boot({
      records: [expired, keptListed, keptRecent, unownedExpired, unsettledTerminal],
      persistence,
    }))

    expect(state.deletes).toEqual([String(unownedExpired.id), String(expired.id)])
    expect(state.records.has(String(keptListed.id))).toBe(true)
    expect(state.records.has(String(keptRecent.id))).toBe(true)
    expect(state.records.has(String(unownedExpired.id))).toBe(false)
    expect(state.records.has(String(unsettledTerminal.id))).toBe(true)
  })

  it('keeps expired records of a live owner', async () => {
    const expired = storedRecord({
      ownerSession: SessionId('alice'),
      status: 'failed',
      detail: 'crashed',
      finishedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      reported: true,
    })
    const persistence = fakePersistence({ logs: new Map(), appended: [] })
    const { state } = tracked(await boot({ records: [expired], persistence, liveAgents: ['alice'] }))
    expect(state.deletes).toEqual([])
  })

  it('evicts immediately when orphanRetentionMs is zero', async () => {
    const expired = storedRecord({
      ownerSession: SessionId('gone'),
      status: 'failed',
      detail: 'crashed',
      finishedAt: Date.now(),
      reported: true,
    })
    const persistence = fakePersistence({ logs: new Map(), appended: [] })
    const { state } = tracked(await boot({ records: [expired], persistence, config: { orphanRetentionMs: 0 } }))
    expect(state.deletes).toEqual([String(expired.id)])
  })

  it('leaves records alone when no persistence seam can classify the owner', async () => {
    const expired = storedRecord({
      ownerSession: SessionId('gone'),
      status: 'failed',
      detail: 'crashed',
      finishedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      reported: true,
    })
    const { state } = tracked(await boot({ records: [expired] }))
    expect(state.deletes).toEqual([])
  })

  it('tolerates a persistence list failure and a store delete failure', async () => {
    const expired = storedRecord({
      ownerSession: SessionId('gone'),
      status: 'failed',
      detail: 'crashed',
      finishedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      reported: true,
    })
    const listFailing = fakePersistence({ logs: new Map(), appended: [], listError: new Error('index lost') })
    const first = tracked(await boot({ records: [expired], persistence: listFailing }))
    expect(first.state.deletes).toEqual([])
    await first.ctx.fiber.dispose()
    contexts.pop()

    const records = new Map([[String(expired.id), expired]])
    const shared = fakeStore(records)
    shared.state.failDeletes = true
    const persistence = fakePersistence({ logs: new Map(), appended: [] })
    const second = tracked(await boot({ store: shared, persistence }))
    expect(second.state.records.has(String(expired.id))).toBe(true)
  })
})

describe('RunSupervisor offline owner append ordering', () => {
  it('assigns unique sequential records to concurrent same-owner accounts', async () => {
    vi.useFakeTimers()
    const logs = new Map<string, SessionEvent[]>([['alice', [seedEvent()]]])
    const persistence = fakePersistence({ logs, appended: [] })
    const records = [
      storedRecord({ ownerSession: SessionId('alice'), resumeSpec: { cmd: 'one' } }),
      storedRecord({ ownerSession: SessionId('alice'), resumeSpec: { cmd: 'two' } }),
    ]
    const { state } = tracked(await boot({ records, persistence }))
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(records.map(record => jobView({} as Context, state, record).status)).toEqual(['failed', 'failed'])
    expect(logs.get('alice')?.slice(1).map(event => event.seq)).toEqual([1, 2])
    expect(new Set(logs.get('alice')?.slice(1).map(event => (event.data as { jobId: JobId }).jobId))).toEqual(new Set(records.map(record => record.id)))
  })
})

describe('RunSupervisor store/registry mismatch', () => {
  it('warns once about records the registry never restored and leaves them alone', async () => {
    const record = storedRecord({ resumeSpec: { cmd: 'rerun' } })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    const { store } = fakeStore(new Map([[String(record.id), record]]))
    ctx.provide('jobStore', store)
    // persist: false — the registry ignores the durable records entirely.
    await ctx.plugin(LocalJobRegistry, { persist: false, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(RunSupervisor, {})
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('were not restored by the registry'))
    expect(store.get(record.id)?.status).toBe('running')
  })
})

describe('RunSupervisor workflow honest settlement', () => {
  it('closes stranded members and the workflow before run/abandoned', async () => {
    const record = storedRecord({ kind: 'workflow', resumeSpec: null, ownerSession: SessionId('alice') })
    const runId = 'workflow-run'
    const logs = new Map<string, SessionEvent[]>([['alice', [
      { type: 'tool-workflow/run-start', seq: 0, time: 1, data: { runId, name: 'audit' } },
      { type: 'tool-workflow/agent-start', seq: 1, time: 2, data: { runId, seq: 1, label: 'done', childId: 'child-1' } },
      { type: 'tool-workflow/agent-start', seq: 2, time: 3, data: { runId, seq: 2, label: 'stranded', childId: 'child-2' } },
      { type: 'tool-workflow/agent-end', seq: 3, time: 4, data: { runId, seq: 1, outcome: 'completed' } },
      { type: 'tool-workflow/agent-start', seq: 4, time: 5, data: { runId, seq: 'invalid', label: 'invalid', childId: 'bad' } },
      { type: 'run/detached', seq: 5, time: 6, data: {
        jobId: record.id, kind: 'workflow', label: record.label, runId, resumable: false,
      } },
    ] as SessionEvent[]]])
    const persistence = fakePersistence({ logs, appended: [] })
    tracked(await boot({ records: [record], persistence }))
    expect(logs.get('alice')?.slice(6).map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/agent-end', { runId, seq: 2, outcome: 'cancelled' }],
      ['tool-workflow/run-end', { runId, stopReason: 'cancelled' }],
      ['run/abandoned', {
        jobId: record.id, kind: 'workflow', priorIncarnation: 'prior-incarnation',
        reason: 'not-resumable', detail: DETAIL_NOT_RESUMABLE,
      }],
    ])
  })

  it('uses the allocated workflow job id to close a run when detachment was not recorded', async () => {
    const runId = 'allocated-run'
    const record = storedRecord({
      id: JobId(`workflow-${runId}`), kind: 'workflow', resumeSpec: null,
      ownerSession: SessionId('alice'),
    })
    const logs = new Map<string, SessionEvent[]>([['alice', [
      { type: 'tool-workflow/run-start', seq: 0, time: 1, data: { runId, name: 'audit' } },
      { type: 'tool-workflow/agent-start', seq: 1, time: 2, data: { runId, seq: 1, label: 'child', childId: 'child-1' } },
    ] as SessionEvent[]]])
    tracked(await boot({
      records: [record], persistence: fakePersistence({ logs, appended: [] }),
    }))
    expect(logs.get('alice')?.slice(2).map(event => event.type)).toEqual([
      'tool-workflow/agent-end', 'tool-workflow/run-end', 'run/abandoned',
    ])
  })

  it('closes a workflow directly in a live owner session', async () => {
    const record = storedRecord({ kind: 'workflow', resumeSpec: null, ownerSession: SessionId('alice') })
    const runId = 'live-workflow'
    const { agents } = tracked(await boot({
      records: [record], liveAgents: ['alice'], liveEvents: { alice: [
        { type: 'tool-workflow/run-start', seq: 0, time: 1, data: { runId, name: 'live' } },
        { type: 'tool-workflow/agent-start', seq: 1, time: 2, data: { runId, seq: 3, label: 'child', childId: 'child' } },
        { type: 'run/detached', seq: 2, time: 3, data: {
          jobId: record.id, kind: 'workflow', label: record.label, runId, resumable: false,
        } },
      ] as SessionEvent[] },
    }))
    expect(agents.get('alice')?.agent.session.events.slice(3).map(event => event.type)).toEqual([
      'tool-workflow/agent-end', 'tool-workflow/run-end', 'run/abandoned',
    ])
  })

  it('does not duplicate closers for an already-ended workflow', async () => {
    const record = storedRecord({ kind: 'workflow', resumeSpec: null, ownerSession: SessionId('alice') })
    const runId = 'ended-workflow'
    const logs = new Map<string, SessionEvent[]>([['alice', [
      { type: 'run/detached', seq: 0, time: 1, data: {
        jobId: record.id, kind: 'workflow', label: record.label, runId, resumable: false,
      } },
      { type: 'tool-workflow/run-end', seq: 1, time: 2, data: { runId, stopReason: 'cancelled' } },
    ] as SessionEvent[]]])
    tracked(await boot({ records: [record], persistence: fakePersistence({ logs, appended: [] }) }))
    expect(logs.get('alice')?.map(event => event.type)).toEqual([
      'run/detached', 'tool-workflow/run-end', 'run/abandoned',
    ])
  })

  it('closes reported workflow settlement without delivering a notice', async () => {
    const record = storedRecord({ kind: 'workflow', resumeSpec: null, reported: true, ownerSession: SessionId('alice') })
    const runId = 'reported-workflow'
    const logs = new Map<string, SessionEvent[]>([['alice', [
      { type: 'tool-workflow/run-start', seq: 0, time: 1, data: { runId, name: 'audit' } },
      { type: 'tool-workflow/agent-start', seq: 1, time: 2, data: { runId, seq: 1, label: 'child', childId: 'child' } },
      { type: 'run/detached', seq: 2, time: 3, data: { jobId: record.id, kind: 'workflow', label: record.label, runId, resumable: false } },
    ] as SessionEvent[]]])
    tracked(await boot({ records: [record], persistence: fakePersistence({ logs, appended: [] }) }))
    expect(logs.get('alice')?.slice(3).map(event => event.type)).toEqual(['tool-workflow/agent-end', 'tool-workflow/run-end', 'run/abandoned'])
  })

  it('does not synthesize workflow closers without a matching detached run', async () => {
    const record = storedRecord({ kind: 'workflow', resumeSpec: null, ownerSession: SessionId('alice') })
    const logs = new Map<string, SessionEvent[]>([['alice', [seedEvent()]]])
    const persistence = fakePersistence({ logs, appended: [] })
    tracked(await boot({ records: [record], persistence }))
    expect(logs.get('alice')?.map(event => event.type)).toEqual(['turn/start', 'run/abandoned'])
  })
})

describe('RunSupervisor notice bounds', () => {
  it('honors the record outputLimitBytes with a head-truncated marker', async () => {
    const record = storedRecord({ resumeSpec: null, outputLimitBytes: 80, label: 'a very long label that will not fit the byte cap' })
    const { agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent
    expect(alice.injected).toHaveLength(1)
    const text = (alice.injected[0]?.content[0] as { type: 'text'; text: string }).text
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(80)
    expect(text).toContain('[notice truncated]')
    expect(text.startsWith(`background job ${record.id}`)).toBe(true)
  })

  it('falls back to tail retention for a degenerate byte cap', async () => {
    const record = storedRecord({ resumeSpec: null, outputLimitBytes: 10 })
    const { agents } = tracked(await boot({ records: [record], liveAgents: ['alice'] }))
    const alice = agents.get('alice') as StubAgent
    const text = (alice.injected[0]?.content[0] as { type: 'text'; text: string }).text
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(10)
  })
})

describe('RunSupervisor pending records with unreachable owners', () => {
  it('treats the owner as unknown when no persistence seam exists and settles at the deadline', async () => {
    vi.useFakeTimers()
    const record = storedRecord({ ownerSession: SessionId('zoe'), resumeSpec: { cmd: 'rerun' } })
    const { state } = tracked(await boot({ records: [record] }))
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    // Unknown is not orphan: the record waits for a resumer like any
    // adoptable one and accounts as a deadline expiry, and with no lane to
    // the owner session there is nowhere for an event to go.
    expect(jobView({} as Context, state, record).status).toBe('failed')
  })

  it('settles a restorable-owned pending record offline at the deadline', async () => {
    vi.useFakeTimers()
    const logs = new Map<string, SessionEvent[]>([['kate', [seedEvent()]]])
    const persistence = fakePersistence({ logs, appended: [] })
    const record = storedRecord({ ownerSession: SessionId('kate'), resumeSpec: { cmd: 'rerun' } })
    const { state } = tracked(await boot({ records: [record], persistence }))
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(jobView({} as Context, state, record).status).toBe('failed')
    // The offline append lands at the log's next seq after the seed event.
    expect(logs.get('kate')).toHaveLength(2)
    expect(logs.get('kate')?.[1]).toMatchObject({
      type: 'run/abandoned',
      seq: 1,
      data: { jobId: record.id, reason: 'reconcile-timeout', detail: DETAIL_RECONCILE_TIMEOUT },
    })
  })

  it('appends run/resumed offline when a restorable-owned record is adopted', async () => {
    const logs = new Map<string, SessionEvent[]>([['liam', []]])
    const persistence = fakePersistence({ logs, appended: [] })
    const record = storedRecord({ ownerSession: SessionId('liam'), resumeSpec: { cmd: 'rerun' } })
    const { ctx } = tracked(await boot({ records: [record], persistence }))
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.registerResumer('bash', () => resumePlan(() => ({
      cancel: () => {},
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    })))
    await flush()
    expect(logs.get('liam')).toHaveLength(1)
    expect(logs.get('liam')?.[0]).toMatchObject({
      type: 'run/resumed',
      seq: 0,
      data: { jobId: record.id, kind: 'bash', priorIncarnation: 'prior-incarnation' },
    })
    settle({ status: 'completed' })
    await flush()
  })

  it('retries an offline run/resumed through the live lane when the session comes live mid-append', async () => {
    const logs = new Map<string, SessionEvent[]>([['judy', []]])
    const record = storedRecord({ ownerSession: SessionId('judy'), resumeSpec: { cmd: 'rerun' } })
    const shared = fakeStore(new Map([[String(record.id), record]]))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', shared.store)
    const stub = stubAgent(ctx, 'judy')
    const persistence = fakePersistence({
      logs,
      appended: [],
      appendError: new Error('seq moved'),
      onAppend: () => {
        if (ctx.agents.get(SessionId('judy')) === undefined) ctx.agents.register(stub.agent)
      },
    })
    ctx.provide('sessionPersistence', persistence as unknown as never)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()
    await ctx.plugin(RunSupervisor, {})
    await flush()
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.registerResumer('bash', () => resumePlan(() => ({
      cancel: () => {},
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    })))
    await flush()
    const resumed = runEvents(stub.agent.session, 'run/resumed')
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.data).toMatchObject({ jobId: record.id, priorIncarnation: 'prior-incarnation' })
    settle({ status: 'completed' })
    await flush()
  })

  it('settles an unowned record without any session account when resumeOnBoot is false', async () => {
    const record = storedRecord({ ownerSession: null, resumeSpec: { cmd: 'rerun' } })
    const { ctx } = tracked(await boot({ records: [record], config: { resumeOnBoot: false } }))
    expect(ctx.jobs.get(record.id).status).toBe('failed')
  })
})

/** One ordinary durable log entry, so offline appends must continue the seq. */
function seedEvent(): SessionEvent {
  return { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
}

describe('RunSupervisor internals (defensive lanes)', () => {
  it('serializes concurrent passes and no-ops listeners with no active pass', async () => {
    const { store, state } = fakeStore()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', store)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()

    const instance = new RunSupervisor(ctx, {
      resumeOnBoot: true, bootResumeTimeoutMs: 1000, maxResumedRunsPerOwner: 1, orphanRetentionMs: 0,
    })
    interface FakePass {
      store: JobStore
      candidates: Map<JobId, { record: JobRecord; membership: 'owned' | 'unowned'; decision: string; detail: string }>
      deadline: AbortController
      emissions: Set<Promise<void>>
      nudge: (() => void) | undefined
    }
    const fakePass = (): FakePass => ({
      store,
      candidates: new Map(),
      deadline: new AbortController(),
      emissions: new Set(),
      nudge: undefined,
    })
    const internals = instance as unknown as {
      passRunning: boolean
      pendingStore: JobStore | undefined
      runPass(store: JobStore): Promise<void>
      onAdopted(snapshot: unknown, priorIncarnation: string): Promise<boolean>
      emitResumed(owner: SessionId, candidate: unknown): Promise<'appended' | 'duplicate' | 'unavailable'>
      accountAdoptionMarkers(pass: FakePass): Promise<void>
      onJobDone(snapshot: unknown): void
      waitForCandidates(pass: FakePass): Promise<void>
      emitAbandoned(pass: FakePass, owner: SessionId, view: unknown, reason: string, priorIncarnation: string): Promise<void>
      deliverNoticeWhenLive(pass: FakePass, owner: SessionId, view: unknown): void
      activePass: FakePass | undefined
      clearAdoptionMarker(candidate: { record: JobRecord }): Promise<void>
    }

    internals.passRunning = true
    await internals.runPass(store) // queues the latest store while a pass is running
    expect(internals.pendingStore).toBe(store)
    internals.pendingStore = undefined
    internals.passRunning = false

    const followList = vi.fn(() => [])
    const followStore = {
      incarnation: store.incarnation, list: followList,
      get: (id: JobId) => store.get(id), put: (record: JobRecord) => store.put(record),
      delete: (id: JobId) => store.delete(id),
    } as unknown as JobStore
    const firstStore = {
      incarnation: store.incarnation,
      list: () => { void internals.runPass(followStore); return [] },
      get: (id: JobId) => store.get(id), put: (record: JobRecord) => store.put(record),
      delete: (id: JobId) => store.delete(id),
    } as unknown as JobStore
    await internals.runPass(firstStore)
    expect(followList).toHaveBeenCalled()
    await internals.clearAdoptionMarker({ record: storedRecord({ adoptedFromIncarnation: 'missing' }) })
    const mismatch = storedRecord({ adoptedFromIncarnation: 'other' })
    state.records.set(String(mismatch.id), mismatch)
    await internals.clearAdoptionMarker({ record: { ...mismatch, adoptedFromIncarnation: 'expected' } })

    // A pass whose store rejects enumeration fails the pass (and the inject
    // lane would contain it), leaving the serializer clean for the next one.
    const badStore = { list: () => { throw new Error('store exploded') } } as unknown as JobStore
    await expect(internals.runPass(badStore)).rejects.toThrow('store exploded')
    expect(internals.passRunning).toBe(false)

    // A markerless adoption is vetoed, while an unrelated completion is ignored.
    await expect(internals.onAdopted(
      { id: JobId(`bash-${randomUUID()}`) },
      'prior-incarnation',
    )).resolves.toBe(false)
    internals.onJobDone({ id: JobId(`bash-${randomUUID()}`), status: 'completed', reported: false })

    const unownedMarker = storedRecord({
      ownerSession: null, adoptedFromIncarnation: 'prior-incarnation',
      incarnation: PROCESS_INCARNATION,
    })
    state.records.set(unownedMarker.id, unownedMarker)
    await expect(internals.onAdopted({ id: unownedMarker.id }, 'prior-incarnation')).resolves.toBe(true)

    const ownedMarker = storedRecord({
      ownerSession: SessionId('alice'), adoptedFromIncarnation: 'prior-incarnation',
      incarnation: PROCESS_INCARNATION,
    })
    state.records.set(ownedMarker.id, ownedMarker)
    const emitResumed = vi.spyOn(internals, 'emitResumed')
    emitResumed.mockRejectedValueOnce(new Error('account failed'))
    await expect(internals.onAdopted({ id: ownedMarker.id }, 'prior-incarnation')).resolves.toBe(false)
    emitResumed.mockResolvedValueOnce('unavailable')
    await expect(internals.onAdopted({ id: ownedMarker.id }, 'prior-incarnation')).resolves.toBe(false)
    emitResumed.mockRestore()

    const staleMarker = storedRecord({
      ownerSession: null, adoptedFromIncarnation: 'old-marker', incarnation: PROCESS_INCARNATION,
    })
    const stalePut = vi.fn(() => Promise.resolve())
    await internals.accountAdoptionMarkers({
      ...fakePass(),
      store: {
        incarnation: store.incarnation, list: () => [staleMarker],
        get: () => ({ ...staleMarker, adoptedFromIncarnation: 'new-marker' }),
        put: stalePut, delete: (id: JobId) => store.delete(id),
      } as unknown as JobStore,
    })
    expect(stalePut).not.toHaveBeenCalled()

    const firstMarker = storedRecord({
      ownerSession: null, adoptedFromIncarnation: 'first-prior', incarnation: PROCESS_INCARNATION,
    })
    const secondMarker = storedRecord({
      ownerSession: null, adoptedFromIncarnation: 'second-prior', incarnation: PROCESS_INCARNATION,
    })
    const markerRecords = new Map<string, JobRecord>([
      [firstMarker.id, firstMarker], [secondMarker.id, secondMarker],
    ])
    const markerPuts = vi.fn((record: JobRecord) => {
      if (record.id === firstMarker.id) return Promise.reject(new Error('clear failed'))
      markerRecords.set(record.id, record)
      return Promise.resolve()
    })
    await internals.accountAdoptionMarkers({
      ...fakePass(),
      store: {
        incarnation: store.incarnation, list: () => [...markerRecords.values()],
        get: (id: string) => markerRecords.get(id), put: markerPuts,
        delete: (id: JobId) => store.delete(id),
      } as unknown as JobStore,
    })
    expect(markerPuts).toHaveBeenCalledTimes(2)
    expect(markerRecords.get(secondMarker.id)?.adoptedFromIncarnation).toBeUndefined()

    // An adoption naming no pending candidate does not disturb the pass.
    const pending = storedRecord({ resumeSpec: { n: 1 } })
    const pass = fakePass()
    pass.candidates.set(pending.id, { record: pending, membership: 'owned', decision: 'adoptable', detail: '' })
    internals.activePass = pass
    await expect(internals.onAdopted(
      { id: JobId(`bash-${randomUUID()}`) },
      'prior-incarnation',
    )).resolves.toBe(false)
    expect(pass.candidates.size).toBe(1)

    // A wait loop entered with an already-aborted deadline resolves at once.
    pass.deadline.abort()
    await internals.waitForCandidates(pass)
    internals.activePass = undefined

    // A producer outcome with no detail falls back to the lane detail; an
    // emission with no detail appends an empty one, and a claim against an
    // already-evicted record is contained.
    const stub = stubAgent(ctx, 'alice')
    ctx.agents.register(stub.agent)
    const detailLess = storedRecord({ resumeSpec: { n: 3 } })
    internals.activePass = pass
    pass.deadline = new AbortController()
    pass.candidates.set(detailLess.id, { record: detailLess, membership: 'owned', decision: 'adoptable', detail: '' })
    internals.onJobDone({
      id: detailLess.id, kind: 'bash', label: 'restored job', status: 'failed',
      reported: false, resumable: true, incarnation: 'prior-incarnation',
      ordinal: 1, startedAt: 100,
    })
    await flush()
    const abandoned = runEvents(stub.agent.session, 'run/abandoned')
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.data).toMatchObject({ reason: 'resume-failed', detail: REGISTRY_NOT_RESUMABLE_DETAIL })
    expect(stub.injected).toHaveLength(1)
    internals.activePass = undefined

    const ghostPass = fakePass()
    internals.deliverNoticeWhenLive(ghostPass, SessionId('alice'), {
      id: JobId(`bash-${randomUUID()}`), kind: 'bash', label: 'ghost',
      status: 'failed', detail: undefined, reported: false, outputLimitBytes: undefined,
    })
    await flush()
    // The notice went out even without a registry record to claim.
    expect(stub.injected).toHaveLength(2)
    const ghostText = (stub.injected[1]?.content[0] as { type: 'text'; text: string }).text
    expect(ghostText).toContain('[status: failed]')

    // A settlement unrelated to any candidate or adopted record is ignored
    // even with a pass active.
    internals.activePass = fakePass()
    internals.onJobDone({ id: JobId(`bash-${randomUUID()}`), status: 'completed', reported: false })
    internals.activePass = undefined

    // An abandonment account without detail appends an empty one.
    const silentPass = fakePass()
    const silentId = JobId(`bash-${randomUUID()}`)
    await internals.emitAbandoned(silentPass, SessionId('alice'), {
      id: silentId, kind: 'bash', label: 'silent', status: 'failed',
      detail: undefined, reported: true, outputLimitBytes: undefined,
    }, 'not-resumable', 'prior-incarnation')
    const silent = runEvents(stub.agent.session, 'run/abandoned')
      .find(event => String((event.data as { jobId: JobId }).jobId) === String(silentId))
    expect(silent?.data).toMatchObject({ reason: 'not-resumable', detail: '' })

    // A list failure under an already-aborted deadline returns quietly.
    const ctx2 = new Context()
    contexts.push(ctx2)
    await ctx2.plugin(AgentRegistry)
    const expired = storedRecord({
      ownerSession: SessionId('gone'), status: 'failed', detail: 'crashed',
      finishedAt: 1, reported: true,
    })
    const shared2 = fakeStore(new Map([[String(expired.id), expired]]))
    ctx2.provide('jobStore', shared2.store)
    ctx2.provide('sessionPersistence', fakePersistence({ logs: new Map(), appended: [], listError: new Error('index lost') }) as unknown as never)
    const quiet = new RunSupervisor(ctx2, {
      resumeOnBoot: true, bootResumeTimeoutMs: 1000, maxResumedRunsPerOwner: 1, orphanRetentionMs: 0,
    })
    const warn2 = vi.spyOn(ctx2.logger, 'warn').mockImplementation(() => {})
    const abortedPass = {
      store: shared2.store,
      candidates: new Map(),
      deadline: new AbortController(),
      emissions: new Set<Promise<void>>(),
      nudge: undefined,
    }
    abortedPass.deadline.abort()
    await (quiet as unknown as { evictExpiredOrphans(pass: typeof abortedPass): Promise<void> })
      .evictExpiredOrphans(abortedPass)
    expect(warn2).not.toHaveBeenCalled()
  })

  it('contains a pass failure on the store inject lane without breaking the fiber', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    const exploding = {
      incarnation: PROCESS_INCARNATION,
      list: () => { throw new Error('store exploded') },
      get: () => undefined,
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
    } as unknown as JobStore
    ctx.provide('jobStore', exploding)
    // persist: false keeps jobs-local from adopting the broken store first.
    await ctx.plugin(LocalJobRegistry, { persist: false, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(RunSupervisor, {})
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boot reconciliation failed'))
    expect(ctx.jobs.list()).toEqual([])
  })

  it('retries an offline append through the live lane when the session comes live mid-append', async () => {
    const logs = new Map<string, SessionEvent[]>([['heidi', []]])
    const record = storedRecord({ kind: 'workflow', ownerSession: SessionId('heidi'), resumeSpec: null })
    const shared = fakeStore(new Map([[String(record.id), record]]))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', shared.store)
    const stub = stubAgent(ctx, 'heidi')
    const runId = 'raced-workflow'
    ;(stub.agent.session.append as unknown as (type: string, data: unknown) => void)(
      'tool-workflow/agent-start', { runId, seq: 1, label: 'child', childId: 'child' },
    )
    ;(stub.agent.session.append as unknown as (type: string, data: unknown) => void)('run/detached', {
      jobId: record.id, kind: 'workflow', label: record.label, runId, resumable: false,
    })
    const persistence = fakePersistence({
      logs,
      appended: [],
      appendError: new Error('seq moved'),
      onAppend: () => {
        // The session came live between owner resolution and the offline append.
        if (ctx.agents.get(SessionId('heidi')) === undefined) ctx.agents.register(stub.agent)
      },
    })
    ctx.provide('sessionPersistence', persistence as unknown as never)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()
    await ctx.plugin(RunSupervisor, {})
    await flush()

    const events = runEvents(stub.agent.session, 'run/abandoned')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({ jobId: record.id, reason: 'not-resumable' })
    expect(stub.agent.session.events.map(event => event.type)).toEqual([
      'tool-workflow/agent-start', 'run/detached', 'tool-workflow/agent-end', 'tool-workflow/run-end', 'run/abandoned',
    ])
  })

  it('contains an offline append failure when no lane can reach the session', async () => {
    const logs = new Map<string, SessionEvent[]>([['ivan', []]])
    const persistence = fakePersistence({ logs, appended: [], appendError: new Error('disk full') })
    const record = storedRecord({ ownerSession: SessionId('ivan'), resumeSpec: null })
    const { state } = tracked(await boot({ records: [record], persistence }))
    // The settlement itself is unaffected; only the session account is lost.
    expect(jobView({} as Context, state, record).status).toBe('failed')
    expect(logs.get('ivan')).toHaveLength(0)
  })
})

describe('RunSupervisor pre-seeded log idempotence', () => {
  it('does not re-emit an event already present in the live session log', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    const record = storedRecord({ resumeSpec: null, reported: false })
    const { store, state } = fakeStore(new Map([[String(record.id), record]]))
    void state
    ctx.provide('jobStore', store)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await flush()
    const stub = stubAgent(ctx, 'alice')
    // A previous boot already accounted the abandonment into this log.
    stub.agent.session.append('run/abandoned', {
      jobId: record.id, kind: 'bash', priorIncarnation: 'prior-incarnation',
      reason: 'not-resumable', detail: DETAIL_NOT_RESUMABLE,
    })
    ctx.agents.register(stub.agent)
    await ctx.plugin(RunSupervisor, {})
    await flush()

    expect(runEvents(stub.agent.session, 'run/abandoned')).toHaveLength(1)
    // The notice is still owed exactly once (reported was false) and then claimed.
    expect(stub.injected).toHaveLength(1)
    expect(ctx.jobs.get(record.id, stub.agent).reported).toBe(true)
  })

  it('closes a killed adopted workflow even when its report is already claimed', async () => {
    const record = storedRecord({ id: JobId('workflow-killed'), kind: 'workflow', ownerSession: SessionId('alice'), adoptedFromIncarnation: 'prior-incarnation' })
    const shared = fakeStore(new Map([[String(record.id), record]]))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', shared.store)
    await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    const alice = stubAgent(ctx, 'alice')
    for (const event of [
      { type: 'tool-workflow/run-start', seq: 0, time: 1, data: { runId: 'killed-run', name: 'audit' } },
      { type: 'tool-workflow/agent-start', seq: 1, time: 2, data: { runId: 'killed-run', seq: 1, label: 'child', childId: 'child' } },
      { type: 'run/detached', seq: 2, time: 3, data: { jobId: record.id, kind: 'workflow', label: record.label, runId: 'killed-run', resumable: true } },
    ] as SessionEvent[]) (alice.agent.session.append as unknown as (type: string, data: unknown) => void)(event.type, event.data)
    ctx.agents.register(alice.agent)
    const instance = new RunSupervisor(ctx, {
      resumeOnBoot: true, bootResumeTimeoutMs: 1000, maxResumedRunsPerOwner: 1, orphanRetentionMs: 0,
    })
    const internals = instance as unknown as {
      adopted: Map<JobId, { record: JobRecord; membership: 'owned' | 'unowned'; decision: 'adoptable'; detail: string }>
      onJobDone(snapshot: JobSnapshot): void
    }
    internals.adopted = new Map([[record.id, { record: { ...record, incarnation: 'prior-incarnation' }, membership: 'owned', decision: 'adoptable', detail: '' }]])
    internals.onJobDone({
      id: record.id, ordinal: 1, kind: 'workflow', label: record.label,
      status: 'killed', resumable: true, incarnation: 'current-incarnation',
      detail: 'cancelled', startedAt: 0, finishedAt: 1, reported: true,
    })
    await flush()
    expect(runEvents(alice.agent.session, 'run/abandoned')).toHaveLength(1)
    expect(runEvents(alice.agent.session, 'tool-workflow/run-end')).toHaveLength(1)
    const unowned = { ...record, id: JobId('workflow-unowned'), ownerSession: null }
    internals.adopted = new Map([[unowned.id, { record: { ...unowned, incarnation: 'prior-incarnation' }, membership: 'unowned', decision: 'adoptable', detail: '' }]])
    internals.onJobDone({
      id: unowned.id, ordinal: 2, kind: 'workflow', label: unowned.label,
      status: 'killed', resumable: true, incarnation: 'current-incarnation',
      detail: 'cancelled', startedAt: 0, finishedAt: 1, reported: true,
    })
    await flush()
  })

  it('init-hook wiring tolerates a store that never appears', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, { teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await ctx.plugin(RunSupervisor, {})
    await flush()
    // No jobStore anywhere: nothing to reconcile, nothing happens.
    expect(ctx.jobs.list()).toEqual([])
  })
})
