import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { JobId, PROCESS_INCARNATION } from '@deepseek-ai/dsh-jobs'
import type { JobHooks, JobKind, JobOutcome, JobSnapshot, JobStart } from '@deepseek-ai/dsh-jobs'
import type { JobRecord, JobStore } from '@deepseek-ai/dsh-jobs-store-domain'
import LocalJobRegistry, { type Config as JobsConfig } from '@deepseek-ai/dsh-jobs-local'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    workflow: 'workflow'
  }
}

const agentScopeDisposers = new WeakMap<Agent, () => Promise<void>>()

function stubAgent(ctx: Context, rawId: string, presetScope?: ScopeKey): Agent {
  const id = SessionId(rawId)
  const scopeFiber = ctx.plugin(() => {})
  // `presetScope` reproduces what `agentPresets.compose` does: the agent gets
  // its own key parented to the standing mount's, so the registry's chain walk
  // reaches that preset's layer.
  let agentCtx = scopeFiber.ctx
  if (presetScope !== undefined) {
    const key = {}
    bindScopeParent(key, presetScope)
    agentCtx = createScope(scopeFiber.ctx, key).ctx
  }
  const session = Session.create(id)
  const agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle' as const,
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  agentScopeDisposers.set(agent, async () => { await scopeFiber.dispose() })
  return agent
}

async function disposeAgentScope(agent: Agent): Promise<void> {
  const dispose = agentScopeDisposers.get(agent)
  if (dispose === undefined) throw new Error(`missing test scope for agent "${agent.id}"`)
  await dispose()
}

/** A controllable producer start-spec: settle its `done` on demand, record cancels. */
function producer(overrides: Partial<Omit<JobStart, 'run'> & JobHooks> = {}) {
  let settle!: (outcome: JobOutcome) => void
  let reject!: (error: unknown) => void
  const cancels: (string | undefined)[] = []
  const {
    kind = 'bash', label = 'sleep 60', owner, outputLimitBytes, idHint, durability, ...hookOverrides
  } = overrides
  const hooks: JobHooks = {
    cancel(reason) { cancels.push(reason) },
    done: new Promise<JobOutcome>((res, rej) => { settle = res; reject = rej }),
    ...hookOverrides,
  }
  const spec: JobStart = {
    kind,
    label,
    ...owner !== undefined ? { owner } : {},
    ...outputLimitBytes !== undefined ? { outputLimitBytes } : {},
    ...idHint !== undefined ? { idHint } : {},
    ...durability !== undefined ? { durability } : {},
    run: () => hooks,
  }
  return { spec, settle, reject, cancels }
}

/**
 * An in-memory {@link JobStore} double with injectable write failures. Shares
 * its record map across instances the way the domain store shares a medium,
 * so a second registry can "reboot" over the same records.
 */
function fakeStore(options: { incarnation?: string; records?: Map<string, JobRecord> } = {}) {
  const records = options.records ?? new Map<string, JobRecord>()
  const state = {
    records,
    puts: [] as JobRecord[],
    deletes: [] as string[],
    failNextPuts: 0,
    throwOnPut: false,
    failDeletes: false,
    throwOnDelete: false,
  }
  const store = {
    incarnation: options.incarnation ?? PROCESS_INCARNATION,
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    put: (record: JobRecord): Promise<void> => {
      if (state.throwOnPut) throw new Error('synchronous store failure')
      if (state.failNextPuts > 0) {
        state.failNextPuts -= 1
        return Promise.reject(new Error('injected store failure'))
      }
      records.set(record.id, record)
      state.puts.push(record)
      return Promise.resolve()
    },
    delete: (id: string): Promise<boolean> => {
      if (state.throwOnDelete) throw new Error('synchronous delete failure')
      if (state.failDeletes) return Promise.reject(new Error('injected delete failure'))
      state.deletes.push(id)
      return Promise.resolve(records.delete(id))
    },
  } as unknown as JobStore
  return { store, state }
}

/** Boot a persisting registry over one store double (controller attached, adoption settled). */
async function bootPersisted(store: JobStore, config: JobsConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  ctx.provide('jobStore', store)
  await ctx.plugin(LocalJobRegistry, { persist: true, ...config })
  ctx.jobs.attachController('test-controller')
  await tick()
  return ctx
}

/** One persisted record shaped like a previous process incarnation wrote it. */
function storedRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: JobId('bash-11111111-2222-4333-8444-555555555555'),
    kind: 'bash',
    label: 'restored job',
    ownerSession: null,
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

async function harness(config: JobsConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, config)
  ctx.jobs.attachController('test-controller')
  return ctx
}

/**
 * Attach a job controller the way `tool-jobs` does: from a plugin whose own
 * `inject` resolves `ctx.jobs`, so the service method binds to the REGISTERING
 * context and the controller files into that context's scope layer. Reading the
 * service off a bare scoped context instead throws `cannot get property "jobs"
 * without inject`, which is the same rule the shipped plugin obeys.
 * @param ctx - the context whose scope should own the controller.
 */
async function attachControllerIn(ctx: Context): Promise<void> {
  await ctx.plugin({
    inject: ['jobs'],
    apply(pluginCtx: Context) { pluginCtx.jobs.attachController('tool-jobs') },
  })
}

/** Let the settlement continuation (a `done.then`) run. */
const tick = () => new Promise<void>(r => setTimeout(r, 0))

/** Inspect the internal resolver registry to pin bounded retention while a job stays live. */
function waitResolverCount(ctx: Context, id: JobId): number {
  const service = ctx.jobs as unknown as { store: Map<JobId, { waitResolvers: Set<() => void> }> }
  const job = service.store.get(id)
  if (job === undefined) throw new Error(`missing test job ${id}`)
  return job.waitResolvers.size
}

describe('LocalJobRegistry.start', () => {
  it('preserves the SessionId brand on public owner snapshots', () => {
    expectTypeOf<JobSnapshot['ownerSession']>().toEqualTypeOf<SessionId | undefined>()
  })

  it('refuses to register while no job controller serves the owner', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalJobRegistry)
    expect(() => ctx.jobs.start(producer().spec))
      .toThrow('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)')
  })

  it('refuses an owner whose own composition attaches no controller', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    // Two standing preset mounts over one registry; only the first loads the
    // job controls. The second must not inherit the first's open gate.
    const withControls = createScope(ctx, {})
    const withoutControls = createScope(ctx, {})
    await attachControllerIn(withControls.ctx)

    const served = stubAgent(ctx, 'served', scopeOf(withControls.ctx))
    const unserved = stubAgent(ctx, 'unserved', scopeOf(withoutControls.ctx))
    ctx.agents.register(served)
    ctx.agents.register(unserved)

    expect(() => ctx.jobs.start(producer({ owner: served }).spec)).not.toThrow()
    expect(() => ctx.jobs.start(producer({ owner: unserved }).spec))
      .toThrow('no job controller serves this agent')
    // An unowned producer has no chain to walk, so only a global controller serves it.
    expect(() => ctx.jobs.start(producer().spec))
      .toThrow('no job controller serves this agent')
  })

  it('lets a controller attached without a scope serve every owner', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    // The host-plane composition's own controls: no scope, so the global layer
    // holds them and every owner's read includes it.
    await attachControllerIn(ctx)
    const scoped = stubAgent(ctx, 'scoped', scopeOf(createScope(ctx, {}).ctx))
    ctx.agents.register(scoped)

    expect(() => ctx.jobs.start(producer({ owner: scoped }).spec)).not.toThrow()
    expect(() => ctx.jobs.start(producer().spec)).not.toThrow()
  })

  it('rejects an empty kind, empty label, and invalid output limit', async () => {
    const ctx = await harness()
    expect(() => ctx.jobs.start(producer({ kind: '' as JobKind }).spec)).toThrow('invalid job kind')
    expect(() => ctx.jobs.start(producer({ label: '' }).spec)).toThrow('invalid job label')
    expect(() => ctx.jobs.start(producer({ outputLimitBytes: 0 }).spec)).toThrow('outputLimitBytes')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxConcurrentJobsPerOwner config: %s',
    async (maxConcurrentJobsPerOwner) => {
      const ctx = new Context()
      await expect(ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner }))
        .rejects.toThrow()
    },
  )

  it('accepts the largest safe integer limit', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: Number.MAX_SAFE_INTEGER })
    expect(ctx.jobs).toBeInstanceOf(LocalJobRegistry)
  })

  it('defaults each owner bucket to ten active jobs', async () => {
    const ctx = await harness()
    const live = Array.from({ length: 10 }, () => producer())
    for (const job of live) ctx.jobs.start(job.spec)

    const blocked = producer()
    const run = vi.fn(() => blocked.spec.run())
    expect(() => ctx.jobs.start({ ...blocked.spec, run }))
      .toThrow('background job limit reached for this owner (limit: 10)')
    expect(run).not.toHaveBeenCalled()
    for (const job of live) job.settle({ status: 'completed' })
  })

  it('rejects before producer start and id allocation, then admits immediately after settlement', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: 1 })
    const first = producer()
    expect(ctx.jobs.start(first.spec)).toMatch(/^bash-/)

    const blocked = producer()
    const run = vi.fn(() => blocked.spec.run())
    expect(() => ctx.jobs.start({ ...blocked.spec, run }))
      .toThrow('use job_kill to stop an unneeded job, wait for it to finish, then retry')
    expect(run).not.toHaveBeenCalled()

    first.settle({ status: 'completed' })
    await tick()
    expect(ctx.jobs.start(blocked.spec)).toMatch(/^bash-/)
  })

  it('keeps a stopping job in the bucket until producer settlement', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: 1 })
    const first = producer()
    const id = ctx.jobs.start(first.spec)
    expect(ctx.jobs.kill(id)).toBe('requested')

    const replacement = producer()
    expect(() => ctx.jobs.start(replacement.spec)).toThrow('(limit: 1)')

    first.settle({ status: 'killed' })
    await tick()
    expect(ctx.jobs.start(replacement.spec)).toMatch(/^bash-/)
  })

  it.each(['completed', 'killed', 'failed'] as const)(
    'releases the bucket after a %s terminal outcome',
    async (status) => {
      const ctx = await harness({ maxConcurrentJobsPerOwner: 1 })
      const first = producer()
      ctx.jobs.start(first.spec)
      first.settle({ status })
      await tick()
      expect(() => ctx.jobs.start(producer().spec)).not.toThrow()
    },
  )

  it('isolates exact owners, replacement objects with the same session id, and the unowned bucket', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: 1 })
    const oldOwner = stubAgent(ctx, 'shared-session')
    const detachOld = ctx.agents.register(oldOwner)
    const oldTask = producer({ owner: oldOwner })
    ctx.jobs.start(oldTask.spec)

    const otherOwner = stubAgent(ctx, 'other-session')
    ctx.agents.register(otherOwner)
    expect(() => ctx.jobs.start(producer({ owner: otherOwner }).spec)).not.toThrow()

    detachOld()
    const replacement = stubAgent(ctx, 'shared-session')
    ctx.agents.register(replacement)
    expect(() => ctx.jobs.start(producer({ owner: replacement }).spec)).not.toThrow()

    ctx.jobs.start(producer().spec)
    expect(() => ctx.jobs.start(producer().spec)).toThrow('(limit: 1)')
    expect(() => ctx.jobs.start(producer({ owner: oldOwner }).spec))
      .toThrow('is not the registered agent instance')

    oldTask.settle({ status: 'completed' })
    await tick()
    await disposeAgentScope(oldOwner)
  })

  it('mints kind-prefixed uuid ids, never reusing one across kinds or restarts', async () => {
    const ctx = await harness()
    const first = ctx.jobs.start(producer().spec)
    const second = ctx.jobs.start(producer().spec)
    const uuid = /^bash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    expect(first).toMatch(uuid)
    expect(second).toMatch(uuid)
    expect(first).not.toBe(second)
    expect(ctx.jobs.start(producer({ kind: 'subagent' }).spec)).toMatch(/^subagent-/)
  })

  it('registers under the producer-supplied idHint and rejects collisions before the starter runs', async () => {
    const ctx = await harness()
    expect(ctx.jobs.start(producer({ idHint: 'stable' }).spec)).toBe('bash-stable')

    const collided = producer({ idHint: 'stable' })
    const run = vi.fn(() => collided.spec.run())
    expect(() => ctx.jobs.start({ ...collided.spec, run }))
      .toThrow('job id bash-stable is already registered (idHint collision)')
    expect(run).not.toHaveBeenCalled()
    expect(() => ctx.jobs.start(producer({ idHint: '' }).spec))
      .toThrow('invalid idHint: expected a non-empty string')
  })

  it('numbers each owner bucket with its own 1-based display ordinals', async () => {
    const ctx = await harness()
    const alice = stubAgent(ctx, 'alice')
    ctx.agents.register(alice)
    const a1 = ctx.jobs.start(producer({ owner: alice }).spec)
    const open1 = ctx.jobs.start(producer().spec)
    const a2 = ctx.jobs.start(producer({ owner: alice, kind: 'subagent' }).spec)
    const open2 = ctx.jobs.start(producer().spec)

    expect(ctx.jobs.get(a1, alice).ordinal).toBe(1)
    // The ordinal counts the owner's registrations across kinds.
    expect(ctx.jobs.get(a2, alice).ordinal).toBe(2)
    expect(ctx.jobs.get(open1).ordinal).toBe(1)
    expect(ctx.jobs.get(open2).ordinal).toBe(2)
  })

  it('rejects a durability.recordSession that contradicts the owner session', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const contradicted = producer({ owner })
    expect(() => ctx.jobs.start({
      ...contradicted.spec,
      durability: { recordSession: SessionId('someone-else') },
    })).toThrow('durability.recordSession "someone-else" does not name the owner\'s session "owner"')
    // A matching recordSession is redundant but legal.
    expect(() => ctx.jobs.start({
      ...producer({ owner }).spec,
      durability: { recordSession: SessionId('owner') },
    })).not.toThrow()
  })

  it('fences a recordSession-only registration by that session id', async () => {
    const ctx = await harness()
    const insider = stubAgent(ctx, 'record-owner')
    const outsider = stubAgent(ctx, 'other')
    ctx.agents.register(insider)
    ctx.agents.register(outsider)
    const id = ctx.jobs.start({
      ...producer().spec,
      durability: { recordSession: SessionId('record-owner') },
    })
    expect(ctx.jobs.get(id, insider).ownerSession).toBe('record-owner')
    expect(() => ctx.jobs.get(id, outsider)).toThrow('belongs to another session')
  })

  it('marks snapshots resumable exactly when a non-null resumeSpec was supplied', async () => {
    const ctx = await harness()
    const plain = ctx.jobs.start(producer().spec)
    const nullSpec = ctx.jobs.start({ ...producer().spec, durability: { resumeSpec: null } })
    const resumable = ctx.jobs.start({ ...producer().spec, durability: { resumeSpec: { arg: 1 } } })
    expect(ctx.jobs.get(plain)).toMatchObject({ resumable: false, incarnation: PROCESS_INCARNATION })
    expect(ctx.jobs.get(nullSpec).resumable).toBe(false)
    expect(ctx.jobs.get(resumable).resumable).toBe(true)
  })
})

describe('LocalJobRegistry reads and settlement', () => {
  it('stream kinds read a consuming delta; terminal reads mark reported', async () => {
    const ctx = await harness()
    const chunks = ['first', '', 'rest']
    const p = producer({ readOutput: () => chunks.shift() ?? '' })
    const id = ctx.jobs.start(p.spec)

    expect(ctx.jobs.read(id)).toMatchObject({ text: 'first', snapshot: { status: 'running', reported: false } })
    expect(ctx.jobs.read(id).text).toBe('')

    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    const read = ctx.jobs.read(id)
    expect(read.text).toBe('rest')
    expect(read.snapshot).toMatchObject({ status: 'completed', detail: 'exit code: 0', reported: true })
    expect(read.snapshot.finishedAt).toBeTypeOf('number')
  })

  it('projects a producer-owned model output limit into reads and snapshots', async () => {
    const ctx = await harness()
    const p = producer({ outputLimitBytes: 64, readOutput: () => 'delta' })
    const id = ctx.jobs.start(p.spec)
    expect(ctx.jobs.read(id)).toMatchObject({
      text: 'delta', snapshot: { outputLimitBytes: 64 },
    })
    expect(ctx.jobs.get(id)).toMatchObject({ outputLimitBytes: 64 })
  })

  it('final-output kinds read empty while live, the outcome output idempotently once settled', async () => {
    const ctx = await harness()
    const p = producer({ kind: 'subagent', label: 'research job' })
    const id = ctx.jobs.start(p.spec)

    expect(ctx.jobs.read(id)).toMatchObject({ text: '', snapshot: { status: 'running' } })

    p.settle({ status: 'completed', output: 'final answer' })
    await tick()
    expect(ctx.jobs.read(id).text).toBe('final answer')
    expect(ctx.jobs.read(id).text).toBe('final answer') // idempotent, not consumed
  })

  it('a settled job without output reads as empty text', async () => {
    const ctx = await harness()
    const p = producer({ kind: 'subagent' })
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'failed', detail: 'max-tokens' })
    await tick()
    expect(ctx.jobs.read(id)).toMatchObject({ text: '', snapshot: { status: 'failed', detail: 'max-tokens' } })
  })

  it('throws for unknown job ids', async () => {
    const ctx = await harness()
    expect(() => ctx.jobs.read(JobId('bash-99'))).toThrow('unknown job bash-99')
  })

  it('notifies onJobDone once per job with containment across listeners', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(() => { throw new Error('listener boom') })
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))

    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id, status: 'completed', reported: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener boom'))
  })

  it('contains a rejecting onJobDone listener without starving later listeners', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: JobId[] = []
    ctx.jobs.onJobDone(async () => { throw new Error('async listener boom') })
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot.id))

    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()

    expect(seen).toEqual([id])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onJobDone listener rejected'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('async listener boom'))
  })

  it("contains rejection from the producer's done promise as a failed outcome (producer contract violation)", async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.reject(new Error('transport exploded'))
    await tick()

    expect(ctx.jobs.read(id).snapshot).toMatchObject({ status: 'failed', detail: 'Error: transport exploded' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('producer contract violation'))
  })

  it('unregisters onJobDone listeners with the contributing fiber (HMR safety)', async () => {
    const ctx = await harness()
    const seen: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.onJobDone(snapshot => void seen.push(snapshot.id))
    }, { inject: ['jobs'] }))
    await fiber.dispose()
    // The returned disposer detaches too (the non-fiber path).
    const detach = ctx.jobs.onJobDone(snapshot => void seen.push(snapshot.id))
    detach()

    const p = producer()
    ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(seen).toEqual([])
  })

  it('delivers a scope-chain listener exactly the owners its layer covers', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const standing = createScope(ctx, {})
    const seen: { id: JobId; owner: Agent | undefined }[] = []
    const mount = await standing.ctx.plugin({
      inject: ['jobs'],
      apply(pluginCtx: Context) {
        pluginCtx.jobs.onJobDone((snapshot, owner) => { seen.push({ id: snapshot.id, owner }) })
      },
    })
    const joined = stubAgent(ctx, 'joined', scopeOf(standing.ctx))
    ctx.agents.register(joined)

    const owned = producer({ owner: joined })
    const ownedId = ctx.jobs.start(owned.spec)
    owned.settle({ status: 'completed' })
    // An unowned settlement belongs to no scope chain, so the scoped layer
    // never observes it.
    const unowned = producer()
    ctx.jobs.start(unowned.spec)
    unowned.settle({ status: 'completed' })
    await tick()

    expect(seen).toEqual([{ id: ownedId, owner: joined }])
    await mount.dispose()
    await disposeAgentScope(joined)
  })
})

describe('LocalJobRegistry.kill', () => {
  it('cancels a live job with the forwarded reason and suppresses the notice', async () => {
    const ctx = await harness()
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    expect(ctx.jobs.kill(id, undefined, 'no longer needed')).toBe('requested')
    expect(p.cancels).toEqual(['no longer needed'])
    expect(ctx.jobs.list()[0]).toMatchObject({ status: 'stopping', reported: true })

    p.settle({ status: 'killed' })
    await tick()
    // The listener still fires (telemetry may care), but carries reported: true
    // so the notice path suppresses its redundant "finished".
    expect(seen[0]).toMatchObject({ id, status: 'killed', reported: true })
  })

  it('reports an already-finished job instead of failing', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(ctx.jobs.kill(id)).toBe('already-finished')
  })

  it('propagates a throwing producer cancel and leaves the job untouched', async () => {
    const ctx = await harness()
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))
    let broken = true
    let settle!: (outcome: JobOutcome) => void
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'flaky cancel',
      run: () => ({
        cancel() { if (broken) throw new Error('cancel boom') },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })
    expect(() => ctx.jobs.kill(id)).toThrow('cancel boom')
    // The failed kill mutated NOTHING: still running, notice not suppressed,
    // and a later (successful) kill still works.
    expect(ctx.jobs.get(id)).toMatchObject({ status: 'running', reported: false })
    settle({ status: 'completed' })
    await tick()
    expect(seen[0]).toMatchObject({ id, reported: false }) // notice would still fire

    broken = false
    expect(ctx.jobs.kill(id)).toBe('already-finished')
  })
})

describe('LocalJobRegistry.wait', () => {
  it('resolves with the terminal snapshot when the job settles, marked reported', async () => {
    const ctx = await harness()
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const wait = ctx.jobs.wait(id, 5_000)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    expect(await wait).toMatchObject({ status: 'completed', reported: true })
    // A waiting reader claims delivery before completion listeners inspect the snapshot.
    expect(seen[0]).toMatchObject({ id, reported: true })
  })

  it('returns the live snapshot on timeout without marking reported', async () => {
    const ctx = await harness()
    const id = ctx.jobs.start(producer().spec)
    expect(await ctx.jobs.wait(id, 5)).toMatchObject({ status: 'running', reported: false })
  })

  it('unregisters timed-out and aborted wait resolvers while the job remains live', async () => {
    const ctx = await harness()
    const id = ctx.jobs.start(producer().spec)

    for (let index = 0; index < 3; index += 1) {
      const wait = ctx.jobs.wait(id, 5)
      expect(waitResolverCount(ctx, id)).toBe(1)
      await expect(wait).resolves.toMatchObject({ status: 'running' })
      expect(waitResolverCount(ctx, id)).toBe(0)
    }

    const controller = new AbortController()
    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    expect(waitResolverCount(ctx, id)).toBe(1)
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(waitResolverCount(ctx, id)).toBe(0)
    expect(ctx.jobs.get(id).status).toBe('running')
  })

  it('returns immediately for an already-finished job', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(await ctx.jobs.wait(id, 5_000)).toMatchObject({ status: 'completed', reported: true })
  })

  it('rejects a non-positive or non-finite timeout', async () => {
    const ctx = await harness()
    const id = ctx.jobs.start(producer().spec)
    await expect(ctx.jobs.wait(id, 0)).rejects.toThrow('invalid wait timeout')
    await expect(ctx.jobs.wait(id, Number.NaN)).rejects.toThrow('invalid wait timeout')
  })

  it('an aborted signal rejects the wait only — the job stays alive', async () => {
    const ctx = await harness()
    const id = ctx.jobs.start(producer().spec)

    const controller = new AbortController()
    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(ctx.jobs.list()[0]).toMatchObject({ status: 'running' })

    const preAborted = new AbortController()
    preAborted.abort()
    await expect(ctx.jobs.wait(id, 5_000, undefined, preAborted.signal)).rejects.toThrow('wait aborted')
  })

  it('an abort racing settlement in the same tick does not swallow the notice', async () => {
    const ctx = await harness()
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const controller = new AbortController()
    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    // Settlement is queued first, so abort must remove the waiter synchronously;
    // otherwise settlement suppresses the notice for a reader that receives nothing.
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id, status: 'completed', reported: false })
  })

  it('an abort landing after settlement still delivers the terminal snapshot it owes', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    const seen: JobSnapshot[] = []
    // The listener aborts after settlement released this waiter but before its
    // resolve microtask runs. Releasing waiters ahead of the announcement is
    // what makes that abort harmless; this is the guard on that ordering.
    ctx.jobs.onJobDone((snapshot) => {
      seen.push(snapshot)
      controller.abort()
    })
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await expect(wait).resolves.toMatchObject({ status: 'completed', reported: true })
    expect(seen[0]).toMatchObject({ id, reported: true }) // suppression stays honest: the wait delivered
  })
})

describe('LocalJobRegistry owner isolation', () => {
  it('fences read/kill/wait to the owning session and keeps unowned jobs open', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const other = stubAgent(ctx, 'other')

    const owned = ctx.jobs.start(producer({ owner }).spec)
    const open = ctx.jobs.start(producer().spec)

    // The owner and the unowned job are reachable.
    expect(ctx.jobs.read(owned, owner).snapshot.id).toBe(owned)
    expect(ctx.jobs.read(open, other).snapshot.id).toBe(open)

    // A different session and a no-agent caller are rejected.
    expect(() => ctx.jobs.read(owned, other)).toThrow(`job ${owned} belongs to another session`)
    expect(() => ctx.jobs.kill(owned, other)).toThrow('belongs to another session')
    await expect(ctx.jobs.wait(owned, 10, other)).rejects.toThrow('belongs to another session')
    expect(() => ctx.jobs.read(owned)).toThrow('belongs to another session')
  })

  it('list() shows only caller-owned plus unowned jobs', async () => {
    const ctx = await harness()
    const alice = stubAgent(ctx, 'alice')
    const bob = stubAgent(ctx, 'bob')
    ctx.agents.register(alice)
    ctx.agents.register(bob)

    const aliceTask = ctx.jobs.start(producer({ owner: alice }).spec)
    const bobTask = ctx.jobs.start(producer({ owner: bob }).spec)
    const openTask = ctx.jobs.start(producer({ kind: 'subagent' }).spec)

    expect(ctx.jobs.list(alice).map(t => t.id)).toEqual([aliceTask, openTask])
    expect(ctx.jobs.list(bob).map(t => t.id)).toEqual([bobTask, openTask])
    expect(ctx.jobs.list().map(t => t.id)).toEqual([openTask])
  })

  it('rejects an owned registration when no agent registry is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    expect(() => ctx.jobs.start(producer({ owner: stubAgent(ctx, 'a') }).spec))
      .toThrow('background job ownership requires the agent registry')
    // The failed registration mutated nothing: no stored job, no burned ordinal.
    expect(ctx.jobs.list()).toEqual([])
    const id = ctx.jobs.start(producer().spec)
    expect(ctx.jobs.get(id).ordinal).toBe(1)
  })

  it('a failed owner-cleanup attach leaves the registry unchanged and does not poison the owner', async () => {
    const ctx = await harness()
    const ghost = stubAgent(ctx, 'ghost') // never registered in ctx.agents

    // Exact-instance validation precedes registry mutation and cleanup attachment.
    expect(() => ctx.jobs.start(producer({ owner: ghost }).spec))
      .toThrow('is not the registered agent instance')
    expect(ctx.jobs.list(ghost)).toEqual([])

    // A later valid registration must still attach cleanup for the same object.
    ctx.agents.register(ghost)
    const cancels: (string | undefined)[] = []
    let settle!: (outcome: JobOutcome) => void
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'after retry',
      owner: ghost,
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })
    expect(ctx.jobs.get(id, ghost).ordinal).toBe(1) // the failed attempt burned no ordinal
    await disposeAgentScope(ghost)
    expect(cancels).toEqual(['owner disposed'])
    expect(ctx.jobs.list(ghost)).toEqual([])
  })

  it('rejects a stale owner instance after another agent reuses its id', async () => {
    const ctx = await harness()
    const staleOwner = stubAgent(ctx, 'owner')
    const unregisterStale = ctx.agents.register(staleOwner)
    unregisterStale()

    const currentOwner = stubAgent(ctx, 'owner')
    ctx.agents.register(currentOwner)
    const current = producer({ owner: currentOwner })
    ctx.jobs.start(current.spec) // Attach the current owner's cleanup first.

    const stale = producer({ owner: staleOwner })
    const staleRun = vi.fn(() => stale.spec.run())
    expect(() => ctx.jobs.start({ ...stale.spec, run: staleRun }))
      .toThrow('is not the registered agent instance')
    expect(staleRun).not.toHaveBeenCalled()
    // Access is keyed by the unified session id, so a reconnect carrying the
    // same identity can observe the current job even though stale ownership
    // registration is rejected by exact-instance validation.
    expect(ctx.jobs.list(staleOwner)).toHaveLength(1)
    expect(ctx.jobs.list(currentOwner)).toHaveLength(1)

    current.settle({ status: 'completed' })
    await tick()
    await disposeAgentScope(currentOwner)
  })
})

describe('LocalJobRegistry owner cleanup', () => {
  it('drains the owner: cancels live jobs, awaits settlement, drops snapshots', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)

    // The producer settles only when cancelled — models a child that stops on request.
    let settle!: (outcome: JobOutcome) => void
    const cancels: (string | undefined)[] = []
    ctx.jobs.start({
      kind: 'subagent',
      label: 'long research',
      owner,
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })
    const terminal = producer({ owner })
    ctx.jobs.start(terminal.spec)
    terminal.settle({ status: 'completed' })
    await tick()

    await disposeAgentScope(owner)
    expect(cancels).toEqual(['owner disposed'])
    // Snapshots dropped: nothing of the owner's remains, listing is empty.
    expect(ctx.jobs.list(owner)).toEqual([])
  })

  it('publishes the settled visible set before announcing completion', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const p = producer({ owner })
    ctx.jobs.start(p.spec)
    // Registered after start so only the settlement's notifications are ordered.
    const order: string[] = []
    ctx.jobs.onJobsChanged(() => void order.push('changed'))
    ctx.jobs.onJobDone(() => void order.push('done'))

    p.settle({ status: 'completed' })
    await tick()

    // A completion reporter may open a turn synchronously. Announcing before
    // the visible set is published would let a client render that turn while
    // its job row still reads `running`.
    expect(order).toEqual(['changed', 'done'])
  })

  it('reports a teardown-cancelled record so completion reporters stay quiet', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))

    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'subagent',
      label: 'long research',
      owner,
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })

    // Observers still receive the terminal record; the report bit is what
    // keeps a notice reporter from addressing an owner being destroyed.
    await disposeAgentScope(owner)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.reported).toBe(true)
  })

  it('attaches one cleanup per owner and drains all owned jobs with the scope', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)

    const first = producer({ owner })
    const second = producer({ owner })
    ctx.jobs.start(first.spec)
    ctx.jobs.start(second.spec)
    first.settle({ status: 'completed' })
    second.settle({ status: 'completed' })
    await tick()
    expect(owner.ctx.fiber.getEffects().filter(effect => effect.label === 'jobs.ownerCleanup()')).toHaveLength(1)
    await disposeAgentScope(owner)
    expect(ctx.jobs.list(owner)).toEqual([])
  })

  it('does not let an old scope cleanup cancel a same-id/session replacement job', async () => {
    const ctx = await harness()
    const oldOwner = stubAgent(ctx, 'owner')
    const detachOld = ctx.agents.register(oldOwner)
    const cancels: string[] = []

    function start(owner: Agent, label: string): JobId {
      let settle!: (outcome: JobOutcome) => void
      return ctx.jobs.start({
        kind: 'bash',
        label,
        owner,
        run: () => ({
          cancel() { cancels.push(label); settle({ status: 'killed' }) },
          done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
        }),
      })
    }

    start(oldOwner, 'old job')
    detachOld()
    const replacement = stubAgent(ctx, 'owner')
    ctx.agents.register(replacement)
    const replacementId = start(replacement, 'replacement job')

    await disposeAgentScope(oldOwner)
    expect(cancels).toEqual(['old job'])
    expect(ctx.jobs.list(replacement).map(job => job.id)).toEqual([replacementId])

    await disposeAgentScope(replacement)
    expect(cancels).toEqual(['old job', 'replacement job'])
  })

  it('registers owner cleanup on the agent scope rather than the jobs fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const tasksFiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const ownerCleanupEffects = () => owner.ctx.fiber.getEffects()
      .filter(effect => effect.label === 'jobs.ownerCleanup()')

    const first = producer({ owner })
    ctx.jobs.start(first.spec)
    expect(ownerCleanupEffects()).toHaveLength(1)
    first.settle({ status: 'completed' })
    await tick()
    expect(tasksFiber.getEffects().some(effect => effect.label === 'jobs.ownerCleanup()')).toBe(false)
    await disposeAgentScope(owner)

    // Only the owner registration is released; the long-lived jobs service
    // and its own teardown effect remain active.
    expect(ownerCleanupEffects()).toHaveLength(0)
    expect(ctx.get('jobs')).toBeDefined()
    expect(tasksFiber.getEffects().some(effect => effect.label === 'jobs teardown')).toBe(true)

  })

  it('force-fails a throwing teardown cancel without awaiting producer done, first outcome wins', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))

    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'broken producer',
      owner,
      run: () => ({
        cancel() { throw new Error('cancel boom') },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })

    const drain = disposeAgentScope(owner)
    let drained = false
    void drain.then(() => { drained = true })
    await tick()
    const drainedWithoutProducerDone = drained
    if (!drainedWithoutProducerDone) {
      // Release the producer if the assertion fails so the test can finish.
      settle({ status: 'completed' })
      await drain
    } else {
      // A late producer completion must not replace the failure or notify twice.
      settle({ status: 'completed' })
      await tick()
    }

    expect(drainedWithoutProducerDone).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('work may be orphaned'))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.status).toBe('failed')
    expect(seen[0]?.detail).toContain('cancel threw during teardown')
    expect(ctx.jobs.list(owner)).toEqual([])
  })
})

describe('LocalJobRegistry disposal', () => {
  it('cancels live jobs, awaits settlement, and silences listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalJobRegistry)
    const controller = await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.attachController('test-controller')
    }, { inject: ['jobs'] }))
    void controller

    const seen: string[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot.id))
    let settle!: (outcome: JobOutcome) => void
    const cancels: (string | undefined)[] = []
    ctx.jobs.start({
      kind: 'bash',
      label: 'sleep 600',
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })

    await fiber.dispose()
    expect(cancels).toEqual(['jobs service disposed'])
    // The teardown kill settles AFTER the listener registry closed: silent.
    expect(seen).toEqual([])
  })

  it('force-fails a throwing cancel so service disposal does not await producer done', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))

    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'broken service job',
      run: () => ({
        cancel() { throw new Error('service cancel boom') },
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }),
    })

    const disposal = fiber.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await tick()
    const disposedWithoutProducerDone = disposed
    if (!disposedWithoutProducerDone) {
      // Release the producer if the assertion fails so the test can finish.
      settle({ status: 'completed' })
      await disposal
    } else {
      settle({ status: 'completed' })
      await tick()
    }

    expect(disposedWithoutProducerDone).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('work may be orphaned'))
    expect(seen).toEqual([])
  })

  it('detaches owner effects from still-live agent scopes when the service unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const tasksFiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'owned work',
      owner,
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }),
    })
    const ownerEffects = () => owner.ctx.fiber.getEffects()
      .filter(effect => effect.label === 'jobs.ownerCleanup()')
    expect(ownerEffects()).toHaveLength(1)

    await tasksFiber.dispose()

    expect(ownerEffects()).toHaveLength(0)
  })

  it('drops a scoped layer when its registrations dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    const standing = createScope(ctx, {})
    // One mount contributes both kinds into the same layer, as `tool-jobs`
    // does; unloading it must leave nothing serving the agents that joined it.
    const mount = await standing.ctx.plugin({
      inject: ['jobs'],
      apply(pluginCtx: Context) {
        pluginCtx.jobs.attachController('tool-jobs')
        pluginCtx.jobs.onJobDone(() => {})
      },
    })
    const owner = stubAgent(ctx, 'joined', scopeOf(standing.ctx))
    ctx.agents.register(owner)
    expect(() => ctx.jobs.start(producer({ owner }).spec)).not.toThrow()

    await mount.dispose()

    expect(() => ctx.jobs.start(producer({ owner }).spec))
      .toThrow('no job controller serves this agent')
  })

  it('detaching the last controller re-arms the register fence', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalJobRegistry)
    const detachA1 = ctx.jobs.attachController('a')
    const detachA2 = ctx.jobs.attachController('a') // duplicate name counts independently
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.attachController('b')
    }, { inject: ['jobs'] }))

    detachA1()
    detachA1() // second call of the same disposer is a no-op
    expect(() => ctx.jobs.start(producer().spec)).not.toThrow() // a ×1 + b remain
    detachA2()
    expect(() => ctx.jobs.start(producer().spec)).not.toThrow() // b remains
    await fiber.dispose() // detaches b with its fiber (HMR safety)
    expect(() => ctx.jobs.start(producer().spec)).toThrow('no job controller serves this agent')
  })
})

describe('LocalJobRegistry.onJobsChanged', () => {
  it('fires after registration, the stopping transition, and settlement', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'alice')
    ctx.agents.register(owner)
    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))

    const p = producer({ owner })
    const id = ctx.jobs.start(p.spec)
    // Registration is announced only once the record is readable.
    expect(seen).toEqual(['alice'])
    expect(ctx.jobs.list(owner)).toHaveLength(1)

    expect(ctx.jobs.kill(id, owner)).toBe('requested')
    expect(seen).toEqual(['alice', 'alice'])
    expect(ctx.jobs.get(id, owner).status).toBe('stopping')

    p.settle({ status: 'killed' })
    await tick()
    expect(seen).toEqual(['alice', 'alice', 'alice'])
    expect(ctx.jobs.get(id, owner).status).toBe('killed')
    await disposeAgentScope(owner)
  })

  it('reports an unowned change as undefined, since every caller can see it', async () => {
    const ctx = await harness()
    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))

    ctx.jobs.start(producer().spec)
    expect(seen).toEqual([undefined])
  })

  it('announces the owner-disposal removal, and stays silent when that owner had none', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'alice')
    const bystander = stubAgent(ctx, 'bob')
    ctx.agents.register(owner)
    ctx.agents.register(bystander)
    const p = producer({ owner })
    ctx.jobs.start(p.spec)

    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))
    p.settle({ status: 'completed' })
    await tick()
    expect(seen).toEqual(['alice'])

    // Disposing an owner with no records changes no visible set.
    await disposeAgentScope(bystander)
    expect(seen).toEqual(['alice'])

    await disposeAgentScope(owner)
    expect(seen).toEqual(['alice', 'alice'])
    expect(ctx.jobs.list(owner)).toEqual([])
  })

  it('contains a throwing listener so the lifecycle commit still stands', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(() => { throw new Error('observer boom') })
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))

    const id = ctx.jobs.start(producer().spec)
    expect(id).toMatch(/^bash-/)
    expect(seen).toEqual([undefined])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onJobsChanged listener threw'))
  })

  it('unregisters through its disposer and with its fiber (HMR safety)', async () => {
    const ctx = await harness()
    const seen: number[] = []
    const detach = ctx.jobs.onJobsChanged(() => void seen.push(1))
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.onJobsChanged(() => void seen.push(2))
    }, { inject: ['jobs'] }))

    ctx.jobs.start(producer().spec)
    expect(seen).toEqual([1, 2])

    detach()
    detach() // second call of the same disposer is a no-op
    ctx.jobs.start(producer().spec)
    expect(seen).toEqual([1, 2, 2])

    await fiber.dispose()
    ctx.jobs.start(producer().spec)
    expect(seen).toEqual([1, 2, 2])
  })
})

describe('LocalJobRegistry teardown change notifications', () => {
  it('announces the stopping transition during owner teardown, before settlement', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'alice')
    ctx.agents.register(owner)
    const p = producer({ owner })
    const id = ctx.jobs.start(p.spec)

    const statuses: (string | undefined)[] = []
    ctx.jobs.onJobsChanged((changed) => {
      statuses.push(changed === undefined ? undefined : ctx.jobs.list(changed)[0]?.status)
    })

    // A slow producer keeps teardown parked between cancel and settlement;
    // an observer must not be left showing `running` for that whole window.
    const disposal = disposeAgentScope(owner)
    await tick()
    expect(statuses).toEqual(['stopping'])

    p.settle({ status: 'killed' })
    await disposal
    // Settlement, then the removal that empties the visible set.
    expect(statuses).toEqual(['stopping', 'killed', undefined])
    expect(ctx.jobs.list(owner)).toEqual([])
    void id
  })

  it('announces the emptied set to a listener registered outside this service (reload safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')

    // The api-proxy carrier registers from its own stream context, not the
    // registry's fiber, so it is still listening when the registry unloads.
    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'sleep 600',
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }),
    })
    seen.length = 0

    await fiber.dispose()
    // stopping (teardown cancel), settlement, then the final empty set.
    expect(seen).toEqual([undefined, undefined, undefined])
  })
})

describe('LocalJobRegistry.onJobAdopted', () => {
  it('announces an adoption after the durable marker commits, containing a throwing listener', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 7 } })
    records.set(stored.id, stored)
    const { store, state } = fakeStore({ records })
    const ctx = await bootPersisted(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: { snapshot: JobSnapshot; prior: string; markerAtNotify: string | undefined }[] = []
    ctx.jobs.onJobAdopted(() => { throw new Error('adoption observer boom') })
    ctx.jobs.onJobAdopted((snapshot, priorIncarnation) => {
      seen.push({
        snapshot,
        prior: priorIncarnation,
        markerAtNotify: state.records.get(stored.id)?.adoptedFromIncarnation,
      })
    })

    ctx.jobs.registerResumer('bash', () => ({ cancel: () => {}, done: new Promise<JobOutcome>(() => {}) }))
    await tick()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.snapshot).toMatchObject({ id: stored.id, status: 'running', incarnation: PROCESS_INCARNATION })
    expect(seen[0]?.prior).toBe('prior-incarnation')
    // The announcement follows the durable commit: the observer already
    // finds the re-stamped record carrying its adoption marker, so a crash
    // after this point still lets the next boot account the adoption.
    expect(seen[0]?.markerAtNotify).toBe('prior-incarnation')
    expect(state.records.get(stored.id)).toMatchObject({
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onJobAdopted listener failed'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('adoption observer boom'))
  })

  it('awaits every observer before wiring an already-resolved done, which settles completed', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 7 } })
    records.set(stored.id, stored)
    const { store } = fakeStore({ records })
    const ctx = await bootPersisted(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const gate = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.jobs.onJobAdopted(async () => { await gate.promise; order.push('observer') })
    ctx.jobs.onJobAdopted(async () => { throw new Error('async observer boom') })

    ctx.jobs.registerResumer('bash', () => ({
      cancel: () => {},
      done: Promise.resolve<JobOutcome>({ status: 'completed', detail: 'instant' }),
    }))
    await tick()
    // The done promise resolved before the resumer even ran, but completion
    // wiring attaches only after every observer settles.
    expect(ctx.jobs.get(stored.id).status).toBe('running')
    gate.resolve(undefined)
    await tick()

    expect(order).toEqual(['observer'])
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'completed', detail: 'instant' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('async observer boom'))
  })
})

describe('LocalJobRegistry durable adoption requirement', () => {
  it('rejects the adoption when the marker put rejects: no announcement, honest resume failure', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 7 } })
    records.set(stored.id, stored)
    const { store, state } = fakeStore({ records })
    const ctx = await bootPersisted(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    state.failNextPuts = 1
    const adopted = vi.fn()
    ctx.jobs.onJobAdopted(adopted)
    const cancels: (string | undefined)[] = []

    ctx.jobs.registerResumer('bash', () => ({
      cancel: (reason) => { cancels.push(reason) },
      done: new Promise<JobOutcome>(() => {}),
    }))
    await tick()

    expect(adopted).not.toHaveBeenCalled()
    expect(cancels).toEqual(['resume adoption was not persisted'])
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'failed', detail: 'resume adoption could not be recorded durably' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the durable marker could not be committed'))
    // The local failure must not replace the prior incarnation's durable
    // running record; a later store remount can restore and retry it.
    expect(state.records.get(stored.id)).toMatchObject({ status: 'running', incarnation: 'prior-incarnation' })
    expect(state.records.get(stored.id)?.adoptedFromIncarnation).toBeUndefined()
  })

  it('rejects the adoption when the marker put throws, leaving the prior record for a later boot', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 7 } })
    records.set(stored.id, stored)
    const { store, state } = fakeStore({ records })
    const ctx = await bootPersisted(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    state.throwOnPut = true
    const adopted = vi.fn()
    ctx.jobs.onJobAdopted(adopted)

    ctx.jobs.registerResumer('bash', () => ({ cancel: () => {}, done: new Promise<JobOutcome>(() => {}) }))
    await tick()

    expect(adopted).not.toHaveBeenCalled()
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'failed', detail: 'resume adoption could not be recorded durably' })
    // The store never accepted anything: the prior incarnation's running
    // record survives, so a later boot can retry the resume.
    expect(state.records.get(stored.id)).toMatchObject({ status: 'running', incarnation: 'prior-incarnation' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the durable marker could not be committed'))
  })

  it('contains a throwing cancel after the marker put rejects', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 7 } })
    records.set(stored.id, stored)
    const { store, state } = fakeStore({ records })
    const ctx = await bootPersisted(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    state.failNextPuts = 1
    const adopted = vi.fn()
    ctx.jobs.onJobAdopted(adopted)

    ctx.jobs.registerResumer('bash', () => ({
      cancel: () => { throw new Error('cancel boom') },
      done: new Promise<JobOutcome>(() => {}),
    }))
    await tick()

    expect(adopted).not.toHaveBeenCalled()
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'failed', detail: 'resume adoption could not be recorded durably' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancel of rejected adoption'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancel boom'))
  })

  it('cancels an unmarked adoption without announcing or wiring it, then retries when the store remounts', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 1 } })
    records.set(stored.id, stored)
    const { store, state } = fakeStore({ records })
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const storeFiber = await ctx.plugin((inner: Context) => {
      inner.provide('jobStore', store)
    })
    await ctx.plugin(LocalJobRegistry, { persist: true })
    ctx.jobs.attachController('test-controller')
    await tick()
    const adopted = vi.fn()
    ctx.jobs.onJobAdopted(adopted)
    const first = Promise.withResolvers<JobOutcome>()
    const second = Promise.withResolvers<JobOutcome>()
    const cancels: (string | undefined)[] = []
    const resume = vi.fn()
      .mockReturnValueOnce({ cancel: (reason?: string) => { cancels.push(reason) }, done: first.promise })
      .mockReturnValueOnce({ cancel: () => {}, done: second.promise })

    await storeFiber.dispose()
    ctx.jobs.registerResumer('bash', resume)
    await tick()

    expect(resume).toHaveBeenCalledTimes(1)
    expect(adopted).not.toHaveBeenCalled()
    expect(cancels).toEqual(['resume adoption was not persisted'])
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'failed', incarnation: 'prior-incarnation' })
    expect(state.records.get(stored.id)).toBe(stored)
    expect(state.puts).toEqual([])

    first.resolve({ status: 'completed', detail: 'stale hooks completed' })
    await tick()
    expect(ctx.jobs.get(stored.id).status).toBe('failed')

    await ctx.plugin((inner: Context) => {
      inner.provide('jobStore', store)
    })
    await tick()

    expect(resume).toHaveBeenCalledTimes(2)
    expect(adopted).toHaveBeenCalledTimes(1)
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'running', incarnation: PROCESS_INCARNATION })
    expect(state.records.get(stored.id)).toMatchObject({
      status: 'running',
      incarnation: PROCESS_INCARNATION,
      adoptedFromIncarnation: 'prior-incarnation',
    })

    second.resolve({ status: 'completed', detail: 'retried hooks completed' })
    await tick()
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'completed', detail: 'retried hooks completed' })
  })

  it('a kill landing while the marker commits releases the producer without re-arming the record', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 7 } })
    records.set(stored.id, stored)
    const gate = Promise.withResolvers<undefined>()
    const store = {
      incarnation: PROCESS_INCARNATION,
      list: () => [...records.values()],
      get: (id: string) => records.get(id),
      put: (record: JobRecord): Promise<void> => {
        records.set(String(record.id), record)
        return gate.promise
      },
      delete: (id: string): Promise<boolean> => Promise.resolve(records.delete(id)),
    } as unknown as JobStore
    const ctx = await bootPersisted(store)
    const adopted = vi.fn()
    ctx.jobs.onJobAdopted(adopted)
    const cancels: (string | undefined)[] = []
    let settle!: (outcome: JobOutcome) => void

    ctx.jobs.registerResumer('bash', () => ({
      cancel: (reason) => { cancels.push(reason) },
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    }))
    expect(ctx.jobs.kill(stored.id, undefined, 'stop it')).toBe('requested')
    await tick()
    expect(ctx.jobs.get(stored.id).status).toBe('killed')
    expect(adopted).not.toHaveBeenCalled()

    gate.resolve(undefined)
    await tick()
    // The adoption committed and was announced, but the producer's hooks
    // were released instead of wired onto the terminal record.
    expect(adopted).toHaveBeenCalledTimes(1)
    expect(cancels).toEqual(['killed while the resume adoption committed'])
    settle({ status: 'completed' })
    await tick()
    expect(ctx.jobs.get(stored.id).status).toBe('killed')
  })
})

describe('LocalJobRegistry config validation', () => {
  it.each([
    [{ maxSettledJobs: -1 }],
    [{ maxSettledJobs: 1.5 }],
    [{ teardownGraceMs: 0 }],
    [{ teardownGraceMs: 2_147_483_648 }],
    [{ maxPersistedOutputBytes: 0 }],
    [{ persist: 'yes' as unknown as boolean }],
  ])('rejects invalid durability config at load: %o', async (config) => {
    const ctx = new Context()
    await expect(ctx.plugin(LocalJobRegistry, config)).rejects.toThrow()
  })
})

describe('LocalJobRegistry durable persistence', () => {
  it('mirrors registration, kill, and settlement, keeping reported as committed', async () => {
    const { store, state } = fakeStore()
    const ctx = await bootPersisted(store)
    const p = producer({ durability: { resumeSpec: { cmd: 'rerun' } } })
    const id = ctx.jobs.start(p.spec)
    await tick()
    expect(state.records.get(id)).toMatchObject({
      id,
      kind: 'bash',
      status: 'running',
      reported: false,
      resumeSpec: { cmd: 'rerun' },
      incarnation: PROCESS_INCARNATION,
      schemaVersion: 1,
    })

    expect(ctx.jobs.kill(id, undefined, 'stop it')).toBe('requested')
    await tick()
    expect(state.records.get(id)).toMatchObject({ status: 'stopping', reported: true })

    p.settle({ status: 'killed', detail: 'stopped', output: 'tail' })
    await tick()
    expect(state.records.get(id)).toMatchObject({ status: 'killed', detail: 'stopped', output: 'tail', reported: true })
    expect(state.records.get(id)?.finishedAt).toBeTypeOf('number')
  })

  it('persists the reported flip a terminal read or wait performs', async () => {
    const { store, state } = fakeStore()
    const ctx = await bootPersisted(store)
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(state.records.get(id)).toMatchObject({ status: 'completed', reported: false })

    ctx.jobs.read(id)
    await tick()
    expect(state.records.get(id)).toMatchObject({ status: 'completed', reported: true })
  })

  it('clips persisted output to maxPersistedOutputBytes while in-memory reads stay complete', async () => {
    const { store, state } = fakeStore()
    const ctx = await bootPersisted(store, { maxPersistedOutputBytes: 8 })
    const p = producer({ kind: 'subagent' })
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed', output: '0123456789ABCDEF' })
    await tick()

    expect(ctx.jobs.read(id).text).toBe('0123456789ABCDEF')
    const persisted = state.records.get(id)?.output ?? ''
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(8)
    expect(persisted.endsWith('ABCDEF')).toBe(true)
  })

  it('persist: false with a store mounted writes nothing', async () => {
    const { store, state } = fakeStore()
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', store)
    await ctx.plugin(LocalJobRegistry, { persist: false })
    ctx.jobs.attachController('test-controller')
    await tick()

    const p = producer()
    ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(state.puts).toEqual([])
  })

  it('a rejected store write logs and degrades that record to in-memory only', async () => {
    const { store, state } = fakeStore()
    const ctx = await bootPersisted(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    state.failNextPuts = 1
    const degraded = producer()
    const degradedId = ctx.jobs.start(degraded.spec)
    await tick()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`disabled durable record for ${degradedId}`))

    // Later transitions of the degraded record stay in-memory; the registry
    // record remains authoritative and a healthy sibling still persists.
    degraded.settle({ status: 'completed' })
    await tick()
    expect(state.records.has(degradedId)).toBe(false)
    expect(ctx.jobs.get(degradedId)).toMatchObject({ status: 'completed' })

    const healthy = producer()
    const healthyId = ctx.jobs.start(healthy.spec)
    await tick()
    expect(state.records.has(healthyId)).toBe(true)
  })

  it('a synchronously throwing store put degrades the record the same way', async () => {
    const { store, state } = fakeStore()
    const ctx = await bootPersisted(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    state.throwOnPut = true
    const id = ctx.jobs.start(producer().spec)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`disabled durable record for ${id}`))
    expect(ctx.jobs.get(id).status).toBe('running')
  })

  it('mirrors records that started before the store mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, { persist: true })
    ctx.jobs.attachController('test-controller')
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const { store, state } = fakeStore()
    ctx.provide('jobStore', store)
    await tick()
    expect(state.records.get(id)).toMatchObject({ id, status: 'running' })
  })

  it('does not mirror a pre-store local record over a durable record with the same id', async () => {
    const stored = storedRecord({ resumeSpec: { retry: true } })
    const records = new Map<string, JobRecord>([[stored.id, stored]])
    const { store, state } = fakeStore({ records })
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, { persist: true })
    ctx.jobs.attachController('test-controller')
    const idHint = String(stored.id).slice('bash-'.length)
    const id = ctx.jobs.start(producer({ idHint }).spec)
    expect(id).toBe(stored.id)

    ctx.provide('jobStore', store)
    await tick()

    expect(state.records.get(stored.id)).toBe(stored)
    expect(state.puts).toEqual([])
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'running', incarnation: PROCESS_INCARNATION })
  })

  it('stops writing when the store fiber disposes', async () => {
    const { store, state } = fakeStore()
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const storeFiber = await ctx.plugin((inner: Context) => {
      inner.provide('jobStore', store)
    })
    await ctx.plugin(LocalJobRegistry, { persist: true })
    ctx.jobs.attachController('test-controller')
    await tick()

    const p = producer()
    ctx.jobs.start(p.spec)
    await tick()
    const written = state.puts.length
    expect(written).toBeGreaterThan(0)

    await storeFiber.dispose()
    p.settle({ status: 'completed' })
    await tick()
    expect(state.puts.length).toBe(written)
  })
})

describe('LocalJobRegistry restore and resume', () => {
  it('restores terminal records with their reported flag and session fence intact', async () => {
    const records = new Map<string, JobRecord>()
    const unreported = storedRecord({
      id: JobId('subagent-aaaaaaaa-1111-4111-8111-111111111111'),
      kind: 'subagent',
      status: 'completed',
      output: 'saved answer',
      startedAt: 50,
      finishedAt: 60,
      ownerSession: SessionId('alice'),
    })
    const reported = storedRecord({
      id: JobId('bash-bbbbbbbb-2222-4222-8222-222222222222'),
      status: 'failed',
      detail: 'exit code: 3',
      startedAt: 10,
      finishedAt: 20,
      reported: true,
    })
    records.set(unreported.id, unreported)
    records.set(reported.id, reported)
    const { store, state } = fakeStore({ records })
    const ctx = await bootPersisted(store)
    const alice = stubAgent(ctx, 'alice')
    const bob = stubAgent(ctx, 'bob')
    ctx.agents.register(alice)
    ctx.agents.register(bob)

    // Ordinals are re-assigned in startedAt order; the fence keys on session.
    expect(ctx.jobs.list(alice).map(job => ({ id: job.id, ordinal: job.ordinal, reported: job.reported }))).toEqual([
      { id: reported.id, ordinal: 1, reported: true },
      { id: unreported.id, ordinal: 1, reported: false },
    ])
    expect(ctx.jobs.list(bob).map(job => job.id)).toEqual([reported.id])
    expect(() => ctx.jobs.read(unreported.id, bob)).toThrow('belongs to another session')

    // Reading the restored output flips reported and persists the flip.
    const read = ctx.jobs.read(unreported.id, alice)
    expect(read.text).toBe('saved answer')
    await tick()
    expect(state.records.get(unreported.id)).toMatchObject({ reported: true })
  })

  it('honest-settles a non-resumable record from a previous incarnation at restore', async () => {
    const records = new Map<string, JobRecord>()
    const orphan = storedRecord()
    records.set(orphan.id, orphan)
    const { store, state } = fakeStore({ records })
    const ctx = await bootPersisted(store)

    expect(ctx.jobs.get(orphan.id)).toMatchObject({
      status: 'failed',
      detail: 'not resumable after host restart',
      reported: false,
      resumable: false,
    })
    await tick()
    expect(state.records.get(orphan.id)).toMatchObject({ status: 'failed', detail: 'not resumable after host restart' })
  })

  it('leaves a non-terminal record from this incarnation untouched (in-process reload guard)', async () => {
    const records = new Map<string, JobRecord>()
    const live = storedRecord({ incarnation: PROCESS_INCARNATION, resumeSpec: { keep: true } })
    records.set(live.id, live)
    const { store } = fakeStore({ records })
    const ctx = await bootPersisted(store)

    const resumer = vi.fn(() => undefined)
    ctx.jobs.registerResumer('bash', resumer)
    expect(resumer).not.toHaveBeenCalled()
    expect(ctx.jobs.get(live.id).status).toBe('running')
  })

  it('replays a resumable record when its kind registers a resumer, adopting under the original id', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 7 }, ownerSession: SessionId('alice') })
    records.set(stored.id, stored)
    const { store, state } = fakeStore({ records })
    const ctx = await bootPersisted(store)

    // Visible and killable while awaiting its resumer.
    expect(ctx.jobs.get(stored.id, stubAgent(ctx, 'alice'))).toMatchObject({ status: 'running', resumable: true, incarnation: 'prior-incarnation' })

    let settle!: (outcome: JobOutcome) => void
    const chunks = ['resumed delta']
    const resume = vi.fn(() => ({
      cancel: () => {},
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      readOutput: () => chunks.shift() ?? '',
    }))
    ctx.jobs.registerResumer('bash', resume)

    expect(resume).toHaveBeenCalledWith({
      id: stored.id,
      kind: 'bash',
      label: 'restored job',
      ownerSession: 'alice',
      resumeSpec: { arg: 7 },
      startedAt: 100,
      priorIncarnation: 'prior-incarnation',
    })
    const alice = stubAgent(ctx, 'alice')
    expect(ctx.jobs.get(stored.id, alice)).toMatchObject({ status: 'running', incarnation: PROCESS_INCARNATION })
    await tick()
    expect(state.records.get(stored.id)).toMatchObject({ incarnation: PROCESS_INCARNATION })

    expect(ctx.jobs.read(stored.id, alice).text).toBe('resumed delta')
    settle({ status: 'completed', detail: 'resumed to completion' })
    await tick()
    expect(ctx.jobs.get(stored.id, alice)).toMatchObject({ status: 'completed', detail: 'resumed to completion' })
    expect(state.records.get(stored.id)).toMatchObject({ status: 'completed' })
  })

  it('replays at restore when the resumer registered before the store adopted', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 1 } })
    records.set(stored.id, stored)
    const { store } = fakeStore({ records })
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, { persist: true })
    ctx.jobs.attachController('test-controller')
    const resume = vi.fn(() => undefined)
    ctx.jobs.registerResumer('bash', resume)

    ctx.provide('jobStore', store)
    await tick()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('honest-settles when the resumer declines, and contains a throwing resumer', async () => {
    const declinedRecord = storedRecord({ id: JobId('bash-cccccccc-3333-4333-8333-333333333333'), resumeSpec: { a: 1 } })
    const throwingRecord = storedRecord({ id: JobId('pty-dddddddd-4444-4444-8444-444444444444'), kind: 'pty-send', resumeSpec: { b: 2 } })
    const records = new Map<string, JobRecord>([[declinedRecord.id, declinedRecord], [throwingRecord.id, throwingRecord]])
    const { store } = fakeStore({ records })
    const ctx = await bootPersisted(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    ctx.jobs.registerResumer('bash', () => undefined)
    expect(ctx.jobs.get(declinedRecord.id)).toMatchObject({ status: 'failed', detail: 'not resumable after host restart' })

    ctx.jobs.registerResumer('pty-send', () => { throw new Error('resume boom') })
    expect(ctx.jobs.get(throwingRecord.id)).toMatchObject({ status: 'failed' })
    expect(ctx.jobs.get(throwingRecord.id).detail).toContain('resume handler threw')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resume boom'))
  })

  it('rejects a duplicate resumer per kind and unregisters with its disposer', async () => {
    const ctx = await harness()
    const detach = ctx.jobs.registerResumer('bash', () => undefined)
    expect(() => ctx.jobs.registerResumer('bash', () => undefined))
      .toThrow('a resumer is already registered for job kind "bash"')
    detach()
    expect(() => ctx.jobs.registerResumer('bash', () => undefined)).not.toThrow()
  })

  it('kills a pending-resume record by settling it, forwarding the reason', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 1 } })
    records.set(stored.id, stored)
    const { store } = fakeStore({ records })
    const ctx = await bootPersisted(store)

    expect(ctx.jobs.kill(stored.id, undefined, 'no longer wanted')).toBe('requested')
    expect(ctx.jobs.get(stored.id).status).toBe('stopping')
    await tick()
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'killed', detail: 'no longer wanted' })
  })

  it('kills a pending-resume record without a reason using the honest default detail', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 1 } })
    records.set(stored.id, stored)
    const { store } = fakeStore({ records })
    const ctx = await bootPersisted(store)

    expect(ctx.jobs.kill(stored.id)).toBe('requested')
    await tick()
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'killed', detail: 'killed before resume' })
  })

  it('contains an adopted producer whose done promise rejects', async () => {
    const records = new Map<string, JobRecord>()
    const stored = storedRecord({ resumeSpec: { arg: 1 } })
    records.set(stored.id, stored)
    const { store } = fakeStore({ records })
    const ctx = await bootPersisted(store)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    ctx.jobs.registerResumer('bash', () => ({
      cancel: () => {},
      done: Promise.reject(new Error('adopted transport exploded')),
    }))
    await tick()
    expect(ctx.jobs.get(stored.id)).toMatchObject({ status: 'failed', detail: 'Error: adopted transport exploded' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('producer contract violation'))
  })
})

describe('LocalJobRegistry settled retention', () => {
  it('evicts only reported terminal records, FIFO per owner, dropping the durable mirror', async () => {
    const { store, state } = fakeStore()
    const ctx = await bootPersisted(store, { maxSettledJobs: 1 })

    const first = producer()
    const firstId = ctx.jobs.start(first.spec)
    const second = producer()
    const secondId = ctx.jobs.start(second.spec)
    first.settle({ status: 'completed' })
    second.settle({ status: 'completed' })
    await tick()

    // Two unreported terminal records exceed the cap but both survive:
    // evicting one would lose a completion notice the model never read.
    expect(ctx.jobs.list().map(job => job.id)).toEqual([firstId, secondId])

    ctx.jobs.read(firstId)
    ctx.jobs.read(secondId)
    await tick()
    // Both reported: the older one is evicted down to the cap.
    expect(ctx.jobs.list().map(job => job.id)).toEqual([secondId])
    expect(state.deletes).toContain(firstId)
    expect(() => ctx.jobs.get(firstId)).toThrow(`unknown job ${firstId}`)
  })

  it('maxSettledJobs: 0 retains no reported terminal record and stays per-owner', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, { maxSettledJobs: 0 })
    ctx.jobs.attachController('test-controller')
    const alice = stubAgent(ctx, 'alice')
    const bob = stubAgent(ctx, 'bob')
    ctx.agents.register(alice)
    ctx.agents.register(bob)

    const aliceJob = producer({ owner: alice })
    const aliceId = ctx.jobs.start(aliceJob.spec)
    const bobJob = producer({ owner: bob })
    const bobId = ctx.jobs.start(bobJob.spec)
    aliceJob.settle({ status: 'completed' })
    bobJob.settle({ status: 'completed' })
    await tick()

    // The terminal read still answers, and its reported flip evicts the record.
    expect(ctx.jobs.read(aliceId, alice).snapshot.status).toBe('completed')
    expect(() => ctx.jobs.get(aliceId, alice)).toThrow('unknown job')
    // Bob's unreported record is untouched by alice's eviction.
    expect(ctx.jobs.list(bob).map(job => job.id)).toEqual([bobId])
  })

  it('evicts in-memory only when no store is mounted, and contains a synchronously throwing durable delete', async () => {
    // persist: true with no store: eviction has no durable mirror to drop.
    const bare = new Context()
    await bare.plugin(AgentRegistry)
    await bare.plugin(LocalJobRegistry, { persist: true, maxSettledJobs: 0 })
    bare.jobs.attachController('test-controller')
    const p1 = producer()
    const id1 = bare.jobs.start(p1.spec)
    p1.settle({ status: 'completed' })
    await tick()
    bare.jobs.read(id1)
    expect(() => bare.jobs.get(id1)).toThrow('unknown job')

    // A store whose delete throws synchronously is contained like a rejection.
    const { store, state } = fakeStore()
    const ctx = await bootPersisted(store, { maxSettledJobs: 0 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const p2 = producer()
    const id2 = ctx.jobs.start(p2.spec)
    p2.settle({ status: 'completed' })
    await tick()
    state.throwOnDelete = true
    ctx.jobs.read(id2)
    expect(() => ctx.jobs.get(id2)).toThrow('unknown job')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`failed to evict durable record ${id2}`))
  })

  it('contains a failing durable eviction without losing the in-memory removal', async () => {
    const { store, state } = fakeStore()
    const ctx = await bootPersisted(store, { maxSettledJobs: 0 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    state.failDeletes = true
    ctx.jobs.read(id)
    await tick()
    expect(() => ctx.jobs.get(id)).toThrow('unknown job')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`failed to evict durable record ${id}`))
  })
})

describe('LocalJobRegistry teardown grace', () => {
  it('force-fails producers that never release once teardownGraceMs expires', async () => {
    const { store, state } = fakeStore()
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    ctx.provide('jobStore', store)
    const fiber = await ctx.plugin(LocalJobRegistry, { persist: true, teardownGraceMs: 20 })
    ctx.jobs.attachController('test-controller')
    await tick()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'wedged producer',
      run: () => ({
        cancel() { /* acknowledges but never settles done */ },
        done: new Promise<JobOutcome>(() => {}),
      }),
    })
    // A compliant sibling settles on cancel; the grace pass skips it.
    let settleCompliant!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'compliant producer',
      run: () => ({
        cancel() { setTimeout(() => { settleCompliant({ status: 'killed' }) }, 1) },
        done: new Promise<JobOutcome>((resolve) => { settleCompliant = resolve }),
      }),
    })

    // Disposal must complete despite the wedged producer never settling.
    await fiber.dispose()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not release within teardownGraceMs'))
    await tick()
    expect(state.records.get(id)).toMatchObject({
      status: 'failed',
      detail: 'producer did not release within teardownGraceMs; work may be orphaned',
    })
  })
})

describe('LocalJobRegistry owner index', () => {
  it('stays equivalent to a linear scan under interleaved settle, kill, and disposal', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: 100 })
    const alice = stubAgent(ctx, 'alice')
    const bob = stubAgent(ctx, 'bob')
    ctx.agents.register(alice)
    ctx.agents.register(bob)

    interface InternalTask { owner?: Agent; status: string }
    const service = ctx.jobs as unknown as {
      store: Map<JobId, InternalTask>
      activeTaskCount(owner?: Agent): number
    }
    const linearActive = (owner?: Agent): number => [...service.store.values()]
      .filter(job => job.owner === owner && (job.status === 'running' || job.status === 'stopping'))
      .length
    const check = (): void => {
      for (const owner of [alice, bob, undefined]) {
        expect(service.activeTaskCount(owner)).toBe(linearActive(owner))
      }
    }

    const live = [
      producer({ owner: alice }), producer({ owner: alice }), producer({ owner: bob }), producer(),
    ]
    const ids = live.map(p => ctx.jobs.start(p.spec))
    check()

    ctx.jobs.kill(ids[0]!, alice)
    check()
    live[0]!.settle({ status: 'killed' })
    live[2]!.settle({ status: 'completed' })
    await tick()
    check()

    live[1]!.settle({ status: 'completed' })
    await tick()
    await disposeAgentScope(alice)
    check()
    // Alice's own records are gone; the unowned job remains visible to all.
    expect(ctx.jobs.list(alice).map(job => job.id)).toEqual([ids[3]])
    expect(ctx.jobs.list(bob)).toHaveLength(2)

    live[3]!.settle({ status: 'completed' })
    await tick()
    check()
    await disposeAgentScope(bob)
    check()
  })

  it('tolerates removing a record whose owner bucket is already gone (internal guard)', async () => {
    const ctx = await harness()
    const service = ctx.jobs as unknown as { removeRecord(job: { id: JobId; ownerSession?: SessionId }): void }
    expect(() => { service.removeRecord({ id: JobId('bash-gone'), ownerSession: SessionId('nobody') }) }).not.toThrow()
  })

  it('fails loud when the owner index references a missing record', async () => {
    const ctx = await harness()
    const p = producer()
    ctx.jobs.start(p.spec)
    const service = ctx.jobs as unknown as { byOwner: Map<SessionId | undefined, Set<JobId>> }
    service.byOwner.get(undefined)?.add(JobId('bash-ghost'))
    expect(() => ctx.jobs.start(producer().spec)).toThrow('owner index references missing job bash-ghost')
    // Restore consistency so the producer's settlement can commit cleanly.
    service.byOwner.get(undefined)?.delete(JobId('bash-ghost'))
    p.settle({ status: 'completed' })
    await tick()
  })
})
