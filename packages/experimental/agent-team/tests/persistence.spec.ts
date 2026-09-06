import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService, { seedDescriptorTurn, snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, { TeamId, TeamMessageId } from '../src/index.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const PERSISTENCE_TEST_TIMEOUT_MS = 15_000
const roots: string[] = []
const contexts = new Set<Context>()

/** Detached durable Team read through the same projection definition as the service. */
function durable(agent: Agent): {
  members: TeamMemberSnapshot[]
  tasks: TeamTaskSnapshot[]
  pendingMessages: TeamMessageSnapshot[]
} {
  let projected = teamProjectionDefinition.init(agent.session.header)
  for (const event of agent.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
  if (projected.failure !== undefined) throw new Error(projected.failure)
  const state = projected
  return {
    members: state.members,
    tasks: state.tasks,
    pendingMessages: state.messages.filter(message => !state.delivered.includes(message.id)),
  }
}

/** One externally released barrier for a held durability acknowledgement. */
function barrier(): { readonly promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/**
 * Spawn one settled teammate, author a durable pending wakeup record for it,
 * and dispose the stack: the crash-only prefix a later recovery pass retries.
 * @returns the teammate's durable session id.
 */
async function crashWithPendingWakeup(
  backend: PersistenceMount,
  storageRoot: string,
  rootId: SessionId,
  messageId: TeamMessageId,
  name: string,
): Promise<SessionId> {
  const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
  const lead = first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
  const started = await first.ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: `${name} recovery`,
    prompt: [{ type: 'text', text: 'finish before the crash window' }],
    context: 'fresh',
    provider: 'spawn',
    signal: SIGNAL,
  })
  await vi.waitFor(() => { expect(first.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
  lead.session.append('team/message/queued', {
    version: 1,
    teamId: TeamId(rootId),
    message: {
      id: messageId,
      senderId: rootId,
      senderName: 'lead',
      targetId: started.member.id,
      delivery: 'wakeup',
      content: [{ type: 'text', text: 'deliver only once durability is acknowledged' }],
    },
  })
  await first.ctx.sessions.flush(lead.session)
  await first.dispose()
  return started.member.id
}

/** Resume one Lead for a detached durable read; the caller disposes the stack. */
async function resumedLead(ctx: Context, rootId: SessionId): Promise<Agent> {
  const handle = await ctx.agents.resume({ resumeSessionId: rootId, agentOptions: { provider: 'mock', model: 'mock' } })
  return handle.agent
}

async function disposeContext(ctx: Context): Promise<void> {
  try {
    await ctx.fiber.dispose()
  } finally {
    contexts.delete(ctx)
  }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try {
      await disposeContext(ctx)
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams persistence test cleanup failed')
})

interface PersistenceMount {
  readonly name: string
  mount(ctx: Context, root: string): Promise<{ dispose(): Promise<void> }>
}

const backends: PersistenceMount[] = [
  {
    name: 'JSONL',
    mount: async (ctx, root) => await ctx.plugin(JsonlSessionPersistence, {
      root: join(root, 'jsonl'),
      compression: 'none',
    }),
  },
]

async function stack(
  backend: PersistenceMount,
  root: string,
  script: ConstructorParameters<typeof MockAdapter>[0],
) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await backend.mount(ctx, root)
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return {
    ctx,
    adapter,
    dispose: async () => { await disposeContext(ctx) },
  }
}

function provisioning(childId: SessionId, name: string): TeamMemberSnapshot {
  return {
    id: childId,
    name,
    description: `${name} recovery`,
    provider: 'spawn',
    context: 'fresh',
    phase: 'provisioning',
  }
}

function persistedChild(
  ctx: Context,
  rootId: SessionId,
  childId: SessionId,
  message: ReturnType<typeof createUserMessage>,
) {
  const seed = seedDescriptorTurn(childId, undefined, snapshotSubagentDescriptor({
    mode: 'continuable',
    provider: 'spawn',
    label: 'persisted child fixture',
    agentProvider: 'mock',
    agentModel: 'mock',
  }))
  const child = ctx.sessions.create(childId, {
    seed,
    meta: { parentSession: rootId, origin: 'subagent' },
  })
  child.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [message],
  })
  return child
}

for (const backend of backends) {
  describe(`${backend.name} Agent Teams recovery`, () => {
    it('reconciles a persisted child to active and a missing child to durable failed', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const first = await stack(backend, storageRoot, [textResponse('initial child answer')])
      const activeRootId = SessionId(`${backend.name.toLowerCase()}-active-root`)
      const failedRootId = SessionId(`${backend.name.toLowerCase()}-failed-root`)
      const childId = SessionId(`${backend.name.toLowerCase()}-child`)
      const activeRoot = first.ctx.agentLoop.create(activeRootId, { provider: 'mock', model: 'mock' })
      const failedRoot = first.ctx.agentLoop.create(failedRootId, { provider: 'mock', model: 'mock' })
      // Let each root's startup recovery observe the empty initial log before
      // simulating the crash-only provisioning prefix.
      await Promise.resolve()
      await Promise.resolve()

      activeRoot.session.append('team/member', {
        version: 1,
        teamId: TeamId(activeRoot.id),
        member: provisioning(childId, 'recoverable'),
      })
      failedRoot.session.append('team/member', {
        version: 1,
        teamId: TeamId(failedRoot.id),
        member: provisioning(SessionId(`${backend.name}-missing`), 'missing'),
      })
      await Promise.all([
        first.ctx.sessions.flush(activeRoot.session),
        first.ctx.sessions.flush(failedRoot.session),
      ])
      await first.ctx.subagents.startContinuable({
        childId,
        provider: 'spawn',
        label: 'recoverable recovery',
        request: {
          prompt: [{ type: 'text', text: 'persist before active edge' }],
          parent: activeRoot,
        },
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
      expect((await first.ctx.sessionPersistence.inspect(childId)).events
        .some(event => event.type === 'user/message')).toBe(true)
      await first.dispose()

      const second = await stack(backend, storageRoot, [textResponse('cold resumed answer')])
      const activeHandle = await second.ctx.agents.resume({
        resumeSessionId: activeRootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const failedHandle = await second.ctx.agents.resume({
        resumeSessionId: failedRootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => {
        expect(durable(activeHandle.agent).members[0]?.phase).toBe('active')
        const failedMember = durable(failedHandle.agent).members[0]
        expect(failedMember?.phase).toBe('failed')
        expect(failedMember?.error).toContain('child Session recovery failed')
      }, { timeout: 5_000 })

      const receipt = await second.ctx.agentTeams.sendMessage(activeHandle.agent, {
        target: 'recoverable',
        content: [{ type: 'text', text: 'resume after reconciliation' }],
        delivery: 'wakeup',
        signal: SIGNAL,
      })
      expect(receipt.status).toBe('accepted')
      await vi.waitFor(() => { expect(second.ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
      await vi.waitFor(() => { expect(durable(activeHandle.agent).pendingMessages).toEqual([]) })

      await activeHandle.dispose()
      await failedHandle.dispose()
      await second.dispose()
    })

    it('delivers a wakeup only after its Lead record is acknowledged and reports the sender\'s own dispatch', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-gate-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-gate-root`)
      const childId = SessionId(`${backend.name.toLowerCase()}-gate-child`)
      const first = await stack(backend, storageRoot, [textResponse('initial child answer')])
      const root = first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      await Promise.resolve()
      await Promise.resolve()
      root.session.append('team/member', {
        version: 1,
        teamId: TeamId(root.id),
        member: provisioning(childId, 'gated'),
      })
      await first.ctx.sessions.flush(root.session)
      await first.ctx.subagents.startContinuable({
        childId,
        provider: 'spawn',
        label: 'gated recovery',
        request: {
          prompt: [{ type: 'text', text: 'persist before active edge' }],
          parent: root,
        },
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
      await first.dispose()

      const second = await stack(backend, storageRoot, [textResponse('cold resumed answer')])
      // Hold the Lead's first two durability acknowledgements: the reconciled
      // `active` edge, then the sender's `team/message/queued` record. The
      // persistence write itself proceeds; only the flush barrier is held.
      const holds = [barrier(), barrier()]
      let leadFlushes = 0
      const stopHold = second.ctx.on('session/flush', (session) => {
        if (session.id !== rootId) return undefined
        return holds[leadFlushes++]?.promise
      })
      let childStartedWhileHeld = false
      const stopStart = second.ctx.on('agent/session-start', ({ agent }) => {
        if (agent.id === childId && leadFlushes <= 2) childStartedWhileHeld = true
      })
      try {
        const rootHandle = await second.ctx.agents.resume({
          resumeSessionId: rootId,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        await vi.waitFor(() => {
          expect(durable(rootHandle.agent).members[0]?.phase).toBe('active')
        }, { timeout: 5_000 })
        expect(leadFlushes).toBe(1)
        // The send lands inside the reconcile transaction's flush window.
        const receipt = second.ctx.agentTeams.sendMessage(rootHandle.agent, {
          target: 'gated',
          content: [{ type: 'text', text: 'resume after reconciliation' }],
          delivery: 'wakeup',
          signal: SIGNAL,
        })
        holds[0]!.release()
        await vi.waitFor(() => { expect(durable(rootHandle.agent).pendingMessages).toHaveLength(1) })
        expect(leadFlushes).toBe(2)
        // Let every chain that could observe the unacknowledged record settle.
        await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
        expect(childStartedWhileHeld).toBe(false)
        expect(second.ctx.agents.get(childId)).toBeUndefined()
        expect(second.adapter.requests).toEqual([])
        const queued = durable(rootHandle.agent).pendingMessages[0]!
        expect((await second.ctx.sessionPersistence.inspect(childId)).events
          .some(event => event.type === 'user/message' && event.data.source.kind === 'team-message')).toBe(false)

        holds[1]!.release()
        expect(await receipt).toEqual({ messageId: queued.id, status: 'accepted' })
        expect(childStartedWhileHeld).toBe(false)
        await vi.waitFor(() => { expect(second.ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
        await vi.waitFor(() => { expect(durable(rootHandle.agent).pendingMessages).toEqual([]) })
        const child = await second.ctx.sessionPersistence.inspect(childId)
        expect(child.events.filter(event => event.type === 'user/message'
          && event.data.source.kind === 'team-message'
          && event.data.source.messageId === queued.id)).toHaveLength(1)
        await rootHandle.dispose()
        const lead = await second.ctx.sessionPersistence.inspect(rootId)
        expect(lead.events.filter(event => event.type === 'team/message/delivered'
          && event.data.messageId === queued.id)).toHaveLength(1)
      } finally {
        for (const hold of holds) hold.release()
        stopStart()
        stopHold()
        await second.dispose()
      }
    })

    it('refuses recovery delivery while the Lead flush fails and delivers once after it recovers', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-refuse-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-refuse-root`)
      const messageId = TeamMessageId(`${backend.name.toLowerCase()}-refused-message`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const firstLead = first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.agentTeams.spawnTeammate(firstLead, {
        name: 'refuse-worker',
        description: 'flush refusal worker',
        prompt: [{ type: 'text', text: 'finish before the crash window' }],
        context: 'fresh',
        provider: 'spawn',
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
      // A durable queued record whose delivery never happened before the crash.
      firstLead.session.append('team/message/queued', {
        version: 1,
        teamId: TeamId(rootId),
        message: {
          id: messageId,
          senderId: rootId,
          senderName: 'lead',
          targetId: started.member.id,
          delivery: 'wakeup',
          content: [{ type: 'text', text: 'deliver only once durability is acknowledged' }],
        },
      })
      await first.ctx.sessions.flush(firstLead.session)
      await first.dispose()

      const second = await stack(backend, storageRoot, [textResponse('resumed teammate answer')])
      const warnings: string[] = []
      second.ctx.logger.exporter({
        levels: { default: LoggerLevel.WARN },
        export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])) },
      })
      let failing = true
      const stopFailing = second.ctx.on('session/flush', (session) => {
        if (failing && session.id === rootId) return Promise.reject(new Error('simulated durability failure'))
        return undefined
      })
      try {
        const refused = await second.ctx.agents.resume({
          resumeSessionId: rootId,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        await vi.waitFor(() => {
          expect(warnings).toContainEqual(expect.stringContaining(
            `Agent Teams recovery for "${rootId}" failed: simulated durability failure`,
          ))
        }, { timeout: 5_000 })
        expect(second.ctx.agents.get(started.member.id)).toBeUndefined()
        expect(second.adapter.requests).toEqual([])
        expect(durable(refused.agent).pendingMessages.map(message => message.id)).toEqual([messageId])
        expect((await second.ctx.sessionPersistence.inspect(started.member.id)).events
          .some(event => event.type === 'user/message' && event.data.source.kind === 'team-message')).toBe(false)

        failing = false
        await refused.dispose()
        const recovered = await second.ctx.agents.resume({
          resumeSessionId: rootId,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        await vi.waitFor(() => { expect(durable(recovered.agent).pendingMessages).toEqual([]) }, { timeout: 5_000 })
        await vi.waitFor(() => { expect(second.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
        const child = await second.ctx.sessionPersistence.inspect(started.member.id)
        expect(child.events.filter(event => event.type === 'user/message'
          && event.data.source.kind === 'team-message'
          && event.data.source.messageId === messageId)).toHaveLength(1)
        await recovered.dispose()
        const lead = await second.ctx.sessionPersistence.inspect(rootId)
        expect(lead.events.filter(event => event.type === 'team/message/delivered'
          && event.data.messageId === messageId)).toHaveLength(1)
      } finally {
        failing = false
        stopFailing()
        await second.dispose()
      }
    })

    it('keeps a rejected send out of recovery while the Lead flush fails and reports it pending', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-sender-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-sender-root`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const warnings: string[] = []
      first.ctx.logger.exporter({
        levels: { default: LoggerLevel.WARN },
        export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])) },
      })
      const lead = first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.agentTeams.spawnTeammate(lead, {
        name: 'sender-worker',
        description: 'sender flush failure worker',
        prompt: [{ type: 'text', text: 'finish before the durability failure' }],
        context: 'fresh',
        provider: 'spawn',
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
      const requestsBeforeFailure = first.adapter.requests.length
      let failing = true
      const stopFailing = first.ctx.on('session/flush', (session) => {
        if (failing && session.id === rootId) return Promise.reject(new Error('simulated durability failure'))
        return undefined
      })
      let childHandle: { dispose(): Promise<void> } | undefined
      try {
        await expect(first.ctx.agentTeams.sendMessage(lead, {
          target: 'sender-worker',
          content: [{ type: 'text', text: 'sent while durability fails' }],
          delivery: 'wakeup',
          signal: SIGNAL,
        })).rejects.toThrow('simulated durability failure')
        // The rejected record stays in the live projection, pending and undelivered.
        const pending = durable(lead).pendingMessages
        expect(pending).toHaveLength(1)
        expect(first.ctx.agents.get(started.member.id)).toBeUndefined()
        expect(first.adapter.requests).toHaveLength(requestsBeforeFailure)

        // A member start while the failure persists refuses recovery instead
        // of delivering the record the Lead log may not hold.
        childHandle = await first.ctx.agents.resume({
          resumeSessionId: started.member.id,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        await vi.waitFor(() => {
          expect(warnings).toContainEqual(expect.stringContaining(
            `Agent Teams recovery for "${started.member.id}" failed: simulated durability failure`,
          ))
        }, { timeout: 5_000 })
        expect(first.ctx.sessions.get(started.member.id)?.ownEvents()
          .some(event => event.type === 'user/message' && event.data.source.kind === 'team-message')).toBe(false)
        expect(durable(lead).pendingMessages.map(message => message.id)).toEqual([pending[0]!.id])
        expect(first.adapter.requests).toHaveLength(requestsBeforeFailure)

        failing = false
        stopFailing()
        await childHandle.dispose()
        childHandle = undefined
        await first.dispose()

        // Once the retained write reaches the log, a later pass delivers the
        // record the sender was told had failed: a rejected send is an unknown
        // outcome, not a guarantee of non-delivery.
        const second = await stack(backend, storageRoot, [textResponse('resumed teammate answer')])
        const rootHandle = await second.ctx.agents.resume({
          resumeSessionId: rootId,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        await vi.waitFor(() => { expect(durable(rootHandle.agent).pendingMessages).toEqual([]) }, { timeout: 5_000 })
        await vi.waitFor(() => { expect(second.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
        const child = await second.ctx.sessionPersistence.inspect(started.member.id)
        expect(child.events.filter(event => event.type === 'user/message'
          && event.data.source.kind === 'team-message'
          && event.data.source.messageId === pending[0]!.id)).toHaveLength(1)
        await rootHandle.dispose()
        await second.dispose()
      } finally {
        failing = false
        stopFailing()
        await childHandle?.dispose()
      }
    })

    it('holds runtime disposal until a recovery pass waiting on the Lead flush settles', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-quiesce-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-quiesce-root`)
      const messageId = TeamMessageId(`${backend.name.toLowerCase()}-quiesce-message`)
      const started = await crashWithPendingWakeup(backend, storageRoot, rootId, messageId, 'quiesce-worker')

      const second = await stack(backend, storageRoot, [textResponse('resumed teammate answer')])
      const hold = barrier()
      const flushRequested = barrier()
      let leadFlushes = 0
      const stopHold = second.ctx.on('session/flush', (session) => {
        if (session.id !== rootId) return undefined
        leadFlushes += 1
        if (leadFlushes !== 1) return undefined
        flushRequested.release()
        return hold.promise
      })
      let childStarted = false
      const stopStart = second.ctx.on('agent/session-start', ({ agent }) => {
        if (agent.id === started) childStarted = true
      })
      try {
        await second.ctx.agents.resume({
          resumeSessionId: rootId,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        // The recovery pass is inside its Lead transaction, waiting on the flush.
        await flushRequested.promise
        let disposed = false
        const disposal = second.dispose().then(() => { disposed = true })
        await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
        expect(disposed).toBe(false)
        hold.release()
        await disposal
        expect(childStarted).toBe(false)
        expect(second.adapter.requests).toEqual([])
      } finally {
        hold.release()
        stopStart()
        stopHold()
        await second.dispose()
      }
      const third = await stack(backend, storageRoot, [])
      expect(durable(await resumedLead(third.ctx, rootId)).pendingMessages.map(message => message.id)).toEqual([messageId])
      expect((await third.ctx.sessionPersistence.inspect(started)).events
        .some(event => event.type === 'user/message' && event.data.source.kind === 'team-message')).toBe(false)
      await third.dispose()
    })

    it('dispatches nothing when the Lead left the registry while recovery awaited its flush', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-stale-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-stale-root`)
      const messageId = TeamMessageId(`${backend.name.toLowerCase()}-stale-message`)
      const started = await crashWithPendingWakeup(backend, storageRoot, rootId, messageId, 'stale-worker')

      const second = await stack(backend, storageRoot, [textResponse('resumed teammate answer')])
      const warnings: string[] = []
      second.ctx.logger.exporter({
        levels: { default: LoggerLevel.WARN },
        export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])) },
      })
      const hold = barrier()
      const flushRequested = barrier()
      let leadFlushes = 0
      const stopHold = second.ctx.on('session/flush', (session) => {
        if (session.id !== rootId) return undefined
        leadFlushes += 1
        if (leadFlushes !== 1) return undefined
        flushRequested.release()
        return hold.promise
      })
      let childStarted = false
      const stopStart = second.ctx.on('agent/session-start', ({ agent }) => {
        if (agent.id === started) childStarted = true
      })
      try {
        const rootHandle = await second.ctx.agents.resume({
          resumeSessionId: rootId,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        await flushRequested.promise
        // The Lead leaves the registry while its recovery flush is in flight;
        // the teardown's own flush is the second Lead flush and passes through.
        await rootHandle.dispose()
        expect(second.ctx.agents.get(rootId)).toBeUndefined()
        hold.release()
        // A start whose Lead is gone claims nothing and reports no failure.
        await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
        expect(childStarted).toBe(false)
        expect(second.ctx.agents.get(started)).toBeUndefined()
        expect(warnings).toEqual([])
        expect(second.adapter.requests).toEqual([])
      } finally {
        hold.release()
        stopStart()
        stopHold()
        await second.dispose()
      }
      const third = await stack(backend, storageRoot, [])
      expect(durable(await resumedLead(third.ctx, rootId)).pendingMessages.map(message => message.id)).toEqual([messageId])
      await third.dispose()
    })

    it('pays no Lead flush on a member start with no candidate mail', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-noflush-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-noflush-root`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const firstLead = first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.agentTeams.spawnTeammate(firstLead, {
        name: 'idle-worker',
        description: 'no pending mail worker',
        prompt: [{ type: 'text', text: 'finish with an empty mailbox' }],
        context: 'fresh',
        provider: 'spawn',
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      let leadFlushes = 0
      const stopCount = second.ctx.on('session/flush', (session) => {
        if (session.id === rootId) leadFlushes += 1
      })
      try {
        const rootHandle = await second.ctx.agents.resume({
          resumeSessionId: rootId,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        // Recovery reaches its flush, when it needs one, within the microtasks
        // that follow session start; one macrotask observes the settled pass.
        await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
        expect(durable(rootHandle.agent).pendingMessages).toEqual([])
        expect(leadFlushes).toBe(0)
        await rootHandle.dispose()
      } finally {
        stopCount()
        await second.dispose()
      }
    })

    it('reconciles a provisioning child whose initial prompt is durably pending', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-pending-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-pending-root`)
      const childId = SessionId(`${backend.name.toLowerCase()}-pending-child`)
      const first = await stack(backend, storageRoot, [])
      const root = first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      await Promise.resolve()
      await Promise.resolve()
      root.session.append('team/member', {
        version: 1,
        teamId: TeamId(root.id),
        member: provisioning(childId, 'pending-worker'),
      })
      const initial = createUserMessage({
        content: [{ type: 'text', text: 'durably pending initial task' }],
        source: { kind: 'user' },
      })
      const child = persistedChild(first.ctx, rootId, childId, initial)
      await Promise.all([
        first.ctx.sessions.flush(root.session),
        first.ctx.sessions.flush(child),
      ])
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => {
        expect(durable(rootHandle.agent).members[0]?.phase).toBe('active')
      })
      expect(second.adapter.requests).toEqual([])
      const stored = await second.ctx.sessionPersistence.inspect(childId)
      expect(stored.events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === initial.id))).toBe(true)

      await rootHandle.dispose()
      await second.dispose()
    })

    it('replays queued-minus-delivered mail in FIFO order without waking for quiet mail', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-mail-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-mail-root`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const firstLead = first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.agentTeams.spawnTeammate(firstLead, {
        name: 'mail-worker',
        description: 'mail recovery worker',
        prompt: [{ type: 'text', text: 'finish before restart' }],
        context: 'fresh',
        provider: 'spawn',
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
      const quiet = await first.ctx.agentTeams.sendMessage(firstLead, {
        target: 'mail-worker',
        content: [{ type: 'text', text: 'durable quiet context' }],
        delivery: 'quiet',
        signal: SIGNAL,
      })
      expect(quiet.status).toBe('queued')
      expect(durable(firstLead).pendingMessages.map(message => message.id)).toEqual([quiet.messageId])
      await first.dispose()

      const second = await stack(backend, storageRoot, [textResponse('resumed teammate answer')])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => {
        expect(durable(rootHandle.agent).pendingMessages.map(message => message.id))
          .toEqual([quiet.messageId])
      })
      expect(second.ctx.agents.get(started.member.id)).toBeUndefined()

      const waking = await second.ctx.agentTeams.sendMessage(rootHandle.agent, {
        target: 'mail-worker',
        content: [{ type: 'text', text: 'resume after restart' }],
        delivery: 'wakeup',
        signal: SIGNAL,
      })
      expect(waking.status).toBe('accepted')
      await vi.waitFor(() => { expect(second.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
      await vi.waitFor(() => { expect(durable(rootHandle.agent).pendingMessages).toEqual([]) })

      const child = await second.ctx.sessionPersistence.inspect(started.member.id)
      const peerIds = child.events.flatMap(event => event.type === 'user/message'
        && event.data.source.kind === 'team-message'
        ? [event.data.source.messageId]
        : [])
      expect(peerIds).toEqual([quiet.messageId, waking.messageId])

      await rootHandle.dispose()
      await second.dispose()
    })

    it('acknowledges target-recorded mail after restart without delivering it twice', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-dedup-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-dedup-root`)
      const messageId = TeamMessageId(`${backend.name.toLowerCase()}-recorded-message`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const firstLead = first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.agentTeams.spawnTeammate(firstLead, {
        name: 'dedup-worker',
        description: 'mail deduplication worker',
        prompt: [{ type: 'text', text: 'finish before the crash window' }],
        context: 'fresh',
        provider: 'spawn',
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })

      const targetHandle = await first.ctx.agents.resume({
        resumeSessionId: started.member.id,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      targetHandle.agent.session.append('user/message', createUserMessage({
        content: [
          { type: 'text', text: `Team message ${messageId} from lead:` },
          { type: 'text', text: 'already recorded before acknowledgement' },
        ],
        source: {
          kind: 'team-message',
          teamId: TeamId(rootId),
          messageId,
          senderId: rootId,
          senderName: 'lead',
        },
      }), { surfaceOp: 'append' })
      await first.ctx.sessions.flush(targetHandle.agent.session)
      // Let the pre-queue acknowledgement observer prove there is no mailbox
      // row yet before authoring the simulated crash prefix below.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      await targetHandle.dispose()

      const queued: TeamMessageSnapshot = {
        id: messageId,
        senderId: rootId,
        senderName: 'lead',
        targetId: started.member.id,
        delivery: 'wakeup',
        content: [{ type: 'text', text: 'already recorded before acknowledgement' }],
      }
      firstLead.session.append('team/message/queued', {
        version: 1,
        teamId: TeamId(rootId),
        message: queued,
      })
      await first.ctx.sessions.flush(firstLead.session)
      expect(durable(firstLead).pendingMessages.map(message => message.id)).toEqual([messageId])
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => { expect(durable(rootHandle.agent).pendingMessages).toEqual([]) })
      expect(second.ctx.agents.get(started.member.id)).toBeUndefined()
      expect(second.adapter.requests).toEqual([])

      const child = await second.ctx.sessionPersistence.inspect(started.member.id)
      const occurrences = child.events.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'team-message'
        && event.data.source.messageId === messageId)
      expect(occurrences).toHaveLength(1)

      await rootHandle.dispose()
      await second.dispose()
    })

    it('acknowledges durably pending target mail without cold-resume duplication', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-inbox-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-inbox-root`)
      const childId = SessionId(`${backend.name.toLowerCase()}-inbox-child`)
      const messageId = TeamMessageId(`${backend.name.toLowerCase()}-pending-team-message`)
      const first = await stack(backend, storageRoot, [])
      const root = first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      await Promise.resolve()
      await Promise.resolve()
      const provisioned = provisioning(childId, 'pending-mail-worker')
      const active: TeamMemberSnapshot = {
        ...provisioned,
        phase: 'active',
      }
      const queued: TeamMessageSnapshot = {
        id: messageId,
        senderId: rootId,
        senderName: 'lead',
        targetId: childId,
        delivery: 'wakeup',
        content: [{ type: 'text', text: 'already durable in target inbox' }],
      }
      root.session.append('team/member', {
        version: 1,
        teamId: TeamId(root.id),
        member: provisioned,
      })
      root.session.append('team/member', {
        version: 1,
        teamId: TeamId(root.id),
        member: active,
      })
      root.session.append('team/message/queued', {
        version: 1,
        teamId: TeamId(root.id),
        message: queued,
      })
      const pending = createUserMessage({
        content: [{ type: 'text', text: 'already durable in target inbox' }],
        source: {
          kind: 'team-message',
          teamId: TeamId(rootId),
          messageId,
          senderId: rootId,
          senderName: 'lead',
        },
      })
      const child = persistedChild(first.ctx, rootId, childId, pending)
      await Promise.all([
        first.ctx.sessions.flush(root.session),
        first.ctx.sessions.flush(child),
      ])
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => {
        expect(durable(rootHandle.agent).pendingMessages).toEqual([])
      })
      expect(second.adapter.requests).toEqual([])
      expect(second.ctx.agents.get(childId)).toBeUndefined()
      const stored = await second.ctx.sessionPersistence.inspect(childId)
      const pendingCopies = stored.events.flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.filter(message => message.source.kind === 'team-message'
          && message.source.messageId === messageId)
        : [])
      expect(pendingCopies).toHaveLength(1)

      await rootHandle.dispose()
      await second.dispose()
    })
  })
}
