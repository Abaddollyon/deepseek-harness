/** Session creation, blank-Session reuse, and Agent preset identity through `session.create`. */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { Agent, AgentFactory, AgentOptions, ModelSelectionProjectionState } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition, type AgentPresetDefaults } from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote, testSessionPersistence } from './test-remote.ts'

/** Booted contexts and their temp roots, torn down after each test. */
const contexts: Context[] = []
const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stubAgent(
  session: Session,
  options: AgentOptions,
  selection: ProjectionHandle<ModelSelectionProjectionState>,
): Agent {
  const model = new AgentModel(() => selection.stateOf(session), session, options)
  return Object.assign({ id: session.id, session, status: 'idle' } as unknown as Agent, { options, model })
}

/** A stored Session the persistence double serves until an Agent resumes it. */
interface StoredSession {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface HarnessOptions {
  /** Declared presets; the first is the default. Omitted, no roster is composed. */
  readonly presets?: readonly string[]
  /** Stored Sessions keyed by id. */
  readonly stored?: ReadonlyMap<SessionId, StoredSession>
  /** Stored Sessions whose writer another owner holds. */
  readonly held?: ReadonlySet<SessionId>
  /** Stored Sessions another resume in this process publishes while this one waits for the writer. */
  readonly publishedByOtherResume?: ReadonlySet<SessionId>
  /** Stored Sessions whose storage fails to open for writing. */
  readonly unreadable?: ReadonlySet<SessionId>
  /** Events a resume finds beyond the stored log, as when another Host wrote after the observation. */
  readonly writtenSinceObservation?: ReadonlyMap<SessionId, readonly SessionEvent[]>
  /** Live Sessions whose preset switch the roster refuses as already started. */
  readonly locked?: ReadonlySet<SessionId>
  /** Declared presets whose activation failed. */
  readonly broken?: ReadonlySet<string>
  /** Requested presets whose resolution waits for the paired promise. */
  readonly resolving?: ReadonlyMap<string, Promise<void>>
  /** Workspace placement served to `workspaceId` requests. */
  readonly workspace?: {
    readonly members: readonly SessionId[]
    readonly archived: readonly SessionId[]
    readonly additionalPaths?: readonly string[]
  }
  /** Session defaults each declared preset reads back from `resolve`. */
  readonly defaults?: Readonly<Record<string, AgentPresetDefaults>>
  /** Declared presets that own an execution world; every path is a directory there. */
  readonly worlds?: ReadonlySet<string>
  /** Services composed before the Session controller boots. */
  readonly prepare?: (ctx: Context) => Promise<void>
}

const WORKSPACE = 'workspace-1' as WorkspaceId

async function harness(options: HarnessOptions = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-')))
  tempDirs.push(cwd)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const preset = await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  const selection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const presets = options.presets
  const selections: { sessionId: SessionId; agentPreset: string }[] = []
  const resumed: SessionId[] = []
  if (presets !== undefined) {
    const known = (id?: string): string => {
      const wanted = id ?? presets[0] ?? ''
      if (!presets.includes(wanted)) {
        throw new RemoteError('agent-preset/not-found', `Unknown agent preset: ${wanted}`, {
          agentPreset: wanted, available: [...presets],
        })
      }
      return wanted
    }
    const usable = (id?: string): string => {
      const wanted = known(id)
      if (options.broken?.has(wanted) === true) {
        throw new RemoteError('agent-preset/invalid', 'activation failed', { agentPreset: wanted, reason: 'activation failed' })
      }
      return wanted
    }
    const declared = (id: string): object => {
      const defaults = options.defaults?.[id]
      return { id, ...defaults === undefined ? {} : { defaults } }
    }
    const worldFs = {
      resolve: (path: string) => Promise.resolve(path),
      stat: () => Promise.resolve({ type: 'directory' }),
    }
    ctx.provide('agentPresets', {
      defaultId: presets[0],
      presetForSession: (session: Session) => preset.stateOf(session),
      resolve: (id?: string) => Promise.resolve(id === undefined ? undefined : options.resolving?.get(id))
        .then(() => declared(known(id))),
      mount: (_ctx: Context, id?: string) => Promise.resolve().then(() => ({ id: usable(id) })),
      select: async (agent: Agent, agentPreset: string) => {
        usable(agentPreset)
        if (options.locked?.has(agent.id) === true) {
          throw new RemoteError('agent-preset/locked', 'This session has already started', {
            sessionId: agent.id, agentPreset,
          })
        }
        selections.push({ sessionId: agent.id, agentPreset })
        agent.session.append('agent-preset/selected', { agentPreset })
        // The registry announces each recorded selection.
        ctx.emit('agent-preset/selected', agent.id, agentPreset)
        return agentPreset
      },
      ownsWorld: (id: string) => options.worlds?.has(id) === true,
      serviceForPreset: (id: string, name: string) => options.worlds?.has(id) === true && name === 'fs' ? worldFs : undefined,
    } as never)
  }
  const stored = options.stored ?? new Map<SessionId, StoredSession>()
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([...stored.values()].map(record => record.header)),
    inspect: (id: SessionId) => {
      const record = stored.get(id)
      return Promise.resolve(record === undefined ? undefined : { meta: record.header, events: [...record.events] })
    },
  }) as never)
  const { members, archived, additionalPaths = [] } = options.workspace ?? { members: [], archived: [] }
  const workspace = {
    id: WORKSPACE, path: cwd, sessionIds: members, additionalPaths, attachSession: () => Promise.resolve(),
  }
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === WORKSPACE ? workspace : undefined,
    list: () => [workspace],
    archivedSessionIds: archived,
  } as never)

  /** Enter the Session for setup, then announce creation as the Agent factory does. */
  const publish = async (
    session: Session,
    setup: Parameters<AgentFactory['createAgent']>[1]['setup'],
    agentOptions: AgentOptions = {},
  ): Promise<{ agent: Agent; dispose: () => Promise<void> }> => {
    const agent = stubAgent(session, agentOptions, selection)
    ;(agent as { ctx?: Context }).ctx = ctx
    const detach = ctx.effect(() => ctx.sessions.enter(session))
    try {
      ctx.sessions.announce(session)
      const commit = await setup?.(ctx, agent)
      commit?.commit()
      const unregister = await ctx.agents.register(agent)
      return { agent, dispose: async () => { await unregister(); await detach() } }
    } catch (error) {
      await detach()
      throw error
    }
  }
  const factory: AgentFactory = {
    async createAgent(_ownerCtx, create) {
      const session = ctx.sessions.prepare(create.sessionId, create.meta === undefined ? {} : { meta: create.meta })
      return publish(session, create.setup, create.agentOptions)
    },
    async resume(_ownerCtx, resume) {
      const id = resume.resumeSessionId
      if (options.held?.has(id) === true) {
        throw Object.assign(new Error(`session "${id}" is written by another owner`), { name: 'SessionAlreadyOwnedError' })
      }
      const record = stored.get(id)
      if (record === undefined || options.unreadable?.has(id) === true) {
        throw new Error(`test persistence cannot open Session "${id}" for writing`)
      }
      if (options.publishedByOtherResume?.has(id) === true) {
        await publish(ctx.sessions.prepare(id, { meta: record.header, seed: [...record.events] }), undefined)
        throw Object.assign(new Error(`session "${id}" is written by this process`), { name: 'SessionAlreadyOwnedError' })
      }
      resumed.push(id)
      const session = ctx.sessions.prepare(id, {
        meta: record.header,
        seed: [...record.events, ...options.writtenSinceObservation?.get(id) ?? []],
      })
      return publish(session, resume.setup, resume.agentOptions)
    },
  }
  ctx.agents.setFactory(factory)
  await options.prepare?.(ctx)
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
  })
  const presetOf = (id: SessionId): string | null | undefined => {
    const session = ctx.sessions.get(id)
    return session === undefined ? undefined : preset.stateOf(session)
  }
  const selectedEvents = (id: SessionId): unknown[] => {
    const session = ctx.sessions.get(id)
    return session === undefined ? [] : session.snapshotEvents()
      .filter(event => event.type === 'agent-preset/selected')
      .map(event => event.data)
  }
  const pending = (id: SessionId) => {
    const session = ctx.sessions.get(id)
    if (session === undefined) throw new Error(`missing session ${id}`)
    return selection.stateOf(session).pending
  }
  return { ctx, remote, cwd, workspace, selections, resumed, presetOf, selectedEvents, pending }
}

function storedHeader(id: SessionId, cwd: string, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd, ...extra }
}

function modelSelection(seq: number): SessionEvent {
  return { type: 'model/selection', seq: SessionSeq(seq), time: 1, data: { provider: 'test', model: 'test-model' } }
}

function presetSelection(seq: number, agentPreset: string): SessionEvent {
  return { type: 'agent-preset/selected', seq: SessionSeq(seq), time: 1, data: { agentPreset } }
}

function completedTurn(seq: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(seq), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(seq + 1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('session.create Agent preset identity', () => {
  it('records the requested preset on the Session header', async () => {
    const { ctx, remote } = await harness({ presets: ['standard', 'minimal'] })

    const created = await remote.create({ sessionId: SessionId('s1'), agentPreset: 'minimal' })

    expect(created.ok).toBe(true)
    expect(ctx.sessions.get(SessionId('s1'))?.header.agentPreset).toBe('minimal')
  })

  it('records the roster default when the caller names no preset', async () => {
    const { ctx, remote } = await harness({ presets: ['standard', 'minimal'] })

    await remote.create({ sessionId: SessionId('s2') })

    expect(ctx.sessions.get(SessionId('s2'))?.header.agentPreset).toBe('standard')
  })

  it('rejects an unknown preset', async () => {
    const { remote } = await harness({ presets: ['standard'] })

    const response = await remote.create({ sessionId: SessionId('s3'), agentPreset: 'nope' })

    expect(response).toMatchObject({ ok: false, error: { code: 'agent-preset/not-found' } })
  })

  it('leaves the header preset-less when no roster is composed', async () => {
    const { ctx, remote } = await harness()

    await remote.create({ sessionId: SessionId('s6') })

    expect(ctx.sessions.get(SessionId('s6'))?.header.agentPreset).toBeUndefined()
  })
})

describe('session.create reuse of a live blank Session', () => {
  it('recomposes a blank Session under the default when the caller names no preset', async () => {
    const { remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })

    const reused = await remote.create({ sessionId: SessionId('draft') })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'standard' } })
    expect(selections).toEqual([{ sessionId: 'draft', agentPreset: 'standard' }])
    expect(presetOf(SessionId('draft'))).toBe('standard')
  })

  it('recomposes a blank Session under the named preset', async () => {
    const { remote, selections } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft') })

    const reused = await remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'minimal' } })
    expect(selections).toEqual([{ sessionId: 'draft', agentPreset: 'minimal' }])
  })

  it('keeps a blank Session that already runs the requested preset', async () => {
    const { ctx, remote, selections } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft') })
    ctx.sessions.get(SessionId('draft'))?.append('agent-preset/selected', { agentPreset: 'minimal' })

    const reused = await remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'minimal' } })
    expect(selections).toEqual([])
  })

  it('validates the requested preset before touching the blank Session', async () => {
    const { remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })

    const response = await remote.create({ sessionId: SessionId('draft'), agentPreset: 'deleted' })

    expect(response).toMatchObject({ ok: false, error: { code: 'agent-preset/not-found' } })
    expect(selections).toEqual([])
    expect(presetOf(SessionId('draft'))).toBe('minimal')
  })

  it('keeps the blank Session unchanged when the requested preset fails to activate', async () => {
    const { remote, selections, presetOf } = await harness({
      presets: ['standard', 'broken'],
      broken: new Set(['broken']),
    })
    await remote.create({ sessionId: SessionId('draft') })

    const response = await remote.create({ sessionId: SessionId('draft'), agentPreset: 'broken' })

    expect(response).toMatchObject({ ok: false, error: { code: 'agent-preset/invalid' } })
    expect(selections).toEqual([])
    expect(presetOf(SessionId('draft'))).toBe('standard')
  })

  it('creates a new Session instead of reusing one that has started', async () => {
    const { ctx, remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('talk'), agentPreset: 'minimal' })
    const talk = ctx.sessions.get(SessionId('talk'))
    talk?.append('turn/start', { turn: 1 })
    talk?.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const created = await remote.create({ sessionId: SessionId('talk') })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('talk')
    expect(created.value.agentPreset).toBe('standard')
    expect(selections).toEqual([])
    expect(presetOf(SessionId('talk'))).toBe('minimal')
  })

  it('creates a new Session when a turn starts before the preset switch', async () => {
    const { remote } = await harness({
      presets: ['standard', 'minimal'],
      locked: new Set([SessionId('racing')]),
    })
    await remote.create({ sessionId: SessionId('racing'), agentPreset: 'minimal' })

    const created = await remote.create({ sessionId: SessionId('racing') })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('racing')
  })

  it('serializes concurrent reuse of one Session in request order', async () => {
    const { remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'] })
    await remote.create({ sessionId: SessionId('draft') })

    const [first, second] = await Promise.all([
      remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' }),
      remote.create({ sessionId: SessionId('draft') }),
    ])

    expect(first).toMatchObject({ ok: true, value: { sessionId: 'draft' } })
    expect(second).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'standard' } })
    expect(selections).toEqual([
      { sessionId: 'draft', agentPreset: 'minimal' },
      { sessionId: 'draft', agentPreset: 'standard' },
    ])
    expect(presetOf(SessionId('draft'))).toBe('standard')
  })

  it('claims one Session in arrival order when an earlier preset resolves later', async () => {
    const minimal = Promise.withResolvers<undefined>()
    const { remote, selections, presetOf } = await harness({
      presets: ['standard', 'minimal'], resolving: new Map([['minimal', minimal.promise]]),
    })
    await remote.create({ sessionId: SessionId('draft') })

    const first = remote.create({ sessionId: SessionId('draft'), agentPreset: 'minimal' })
    const second = remote.create({ sessionId: SessionId('draft') })
    await new Promise(resolve => setTimeout(resolve, 0))
    minimal.resolve(undefined)

    expect(await first).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'minimal' } })
    expect(await second).toMatchObject({ ok: true, value: { sessionId: 'draft', agentPreset: 'standard' } })
    expect(selections).toEqual([
      { sessionId: 'draft', agentPreset: 'minimal' },
      { sessionId: 'draft', agentPreset: 'standard' },
    ])
    expect(presetOf(SessionId('draft'))).toBe('standard')
  })

  it('shares one creation between concurrent callers of a new identity', async () => {
    const { ctx, remote } = await harness({ presets: ['standard'] })

    const results = await Promise.all([
      remote.create({ sessionId: SessionId('fresh') }),
      remote.create({ sessionId: SessionId('fresh') }),
    ])

    expect(results).toMatchObject([
      { ok: true, value: { sessionId: 'fresh' } },
      { ok: true, value: { sessionId: 'fresh' } },
    ])
    expect(ctx.agents.list().map(agent => agent.id)).toEqual(['fresh'])
  })

  it('refuses a Session in another directory', async () => {
    const { ctx, remote } = await harness({ presets: ['standard'] })
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-elsewhere-')))
    tempDirs.push(elsewhere)
    await remote.create({ sessionId: SessionId('other'), cwd: elsewhere })

    const response = await remote.create({ sessionId: SessionId('other') })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'session/conflict', details: { sessionId: 'other', existingCwd: elsewhere } },
    })
    expect(ctx.agents.list().map(agent => agent.id)).toEqual(['other'])
  })

  it('refuses a Session in another directory before resolving the requested preset', async () => {
    const { remote } = await harness({ presets: ['standard'] })
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-elsewhere-')))
    tempDirs.push(elsewhere)
    await remote.create({ sessionId: SessionId('other'), cwd: elsewhere })

    const response = await remote.create({ sessionId: SessionId('other'), agentPreset: 'nope' })

    expect(response).toMatchObject({ ok: false, error: { code: 'session/conflict', details: { sessionId: 'other' } } })
  })

  it('leaves a subagent identity to subagent routing', async () => {
    const { ctx, remote, cwd } = await harness({ presets: ['standard'] })
    ctx.sessions.create(SessionId('child'), {
      meta: { cwd, parentSession: SessionId('parent'), origin: 'subagent' },
    })

    const response = await remote.create({ sessionId: SessionId('child') })

    expect(response).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
  })

  it('reuses a preset-less blank Session unchanged when no roster is composed', async () => {
    const { ctx, remote } = await harness()
    await remote.create({ sessionId: SessionId('s5') })

    const reused = await remote.create({ sessionId: SessionId('s5') })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 's5' } })
    expect(ctx.sessions.get(SessionId('s5'))?.header.agentPreset).toBeUndefined()
  })

  it('explains why a preset-less Session cannot be adopted under one', async () => {
    const { remote } = await harness()
    await remote.create({ sessionId: SessionId('s7') })

    const response = await remote.create({ sessionId: SessionId('s7'), agentPreset: 'standard' })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'agent-preset/conflict',
        details: {
          sessionId: 's7',
          requestedPreset: 'standard',
        },
      },
    })
    if (response.ok) throw new Error('unreachable')
    expect('existingPreset' in response.error.details).toBe(false)
    expect(response.error.message).toBe('the deployment composes no agent preset roster, so session "s7" cannot run preset "standard"')
  })
})

describe('session.create reuse of a stored blank Session', () => {
  it('resumes a blank Session whose recorded preset is no longer declared under the default', async () => {
    const draft = SessionId('stale-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, resumed, presetOf, selectedEvents } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'liangshen' }), events: [modelSelection(0)] }]]),
    })

    const reused = await remote.create({ sessionId: draft, cwd })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'stale-draft', agentPreset: 'standard' } })
    expect(resumed).toEqual(['stale-draft'])
    expect(presetOf(draft)).toBe('standard')
    expect(selectedEvents(draft)).toEqual([{ agentPreset: 'standard' }])
  })

  it('resumes a blank Session under the default even when its previous choice is still declared', async () => {
    const draft = SessionId('picked-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, presetOf, selectedEvents } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [presetSelection(0, 'minimal')] }]]),
    })

    const reused = await remote.create({ sessionId: draft, cwd })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'picked-draft', agentPreset: 'standard' } })
    expect(presetOf(draft)).toBe('standard')
    expect(selectedEvents(draft)).toEqual([{ agentPreset: 'minimal' }, { agentPreset: 'standard' }])
  })

  it('resumes a blank Session under its recorded preset when the caller names it', async () => {
    const draft = SessionId('restored-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, presetOf, selectedEvents } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [presetSelection(0, 'minimal')] }]]),
    })

    const reused = await remote.create({ sessionId: draft, cwd, agentPreset: 'minimal' })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'restored-draft', agentPreset: 'minimal' } })
    expect(presetOf(draft)).toBe('minimal')
    expect(selectedEvents(draft)).toEqual([{ agentPreset: 'minimal' }])
  })

  it('rejects a named preset that is no longer declared without resuming the Session', async () => {
    const draft = SessionId('stale-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { ctx, remote, resumed } = await harness({
      presets: ['standard'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'liangshen' }), events: [modelSelection(0)] }]]),
    })

    const response = await remote.create({ sessionId: draft, cwd, agentPreset: 'liangshen' })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent-preset/not-found', details: { agentPreset: 'liangshen', available: ['standard'] } },
    })
    expect(resumed).toEqual([])
    expect(ctx.agents.list()).toEqual([])
  })

  it('creates a new Session instead of resuming one that has started', async () => {
    const talk = SessionId('stored-talk')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, resumed } = await harness({
      presets: ['standard'],
      stored: new Map([[talk, { header: storedHeader(talk, cwd, { agentPreset: 'liangshen' }), events: completedTurn(0) }]]),
    })

    const created = await remote.create({ sessionId: talk, cwd })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('stored-talk')
    expect(created.value.agentPreset).toBe('standard')
    expect(resumed).toEqual([])
  })

  it('creates a new Session when another owner holds the blank Session', async () => {
    const draft = SessionId('held-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { ctx, remote } = await harness({
      presets: ['standard'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [modelSelection(0)] }]]),
      held: new Set([draft]),
    })

    const created = await remote.create({ sessionId: draft, cwd })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('held-draft')
    expect(ctx.sessions.get(draft)).toBeUndefined()
  })

  it('reuses the Agent another resume published while holding the writer', async () => {
    const draft = SessionId('contended-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, selections, presetOf } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'minimal' }), events: [modelSelection(0)] }]]),
      publishedByOtherResume: new Set([draft]),
    })

    const reused = await remote.create({ sessionId: draft, cwd })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'contended-draft', agentPreset: 'standard' } })
    expect(selections).toEqual([{ sessionId: 'contended-draft', agentPreset: 'standard' }])
    expect(presetOf(draft)).toBe('standard')
  })

  it('reports an unreadable Session instead of creating another one', async () => {
    const { ctx, remote } = await harness({ presets: ['standard'] })
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('storage offline'))

    const response = await remote.create({ sessionId: SessionId('unreadable') })

    expect(response).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    expect(ctx.agents.list()).toEqual([])
  })

  it('reports a storage failure instead of creating another Session', async () => {
    const draft = SessionId('unreadable-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { ctx, remote } = await harness({
      presets: ['standard'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [modelSelection(0)] }]]),
      unreadable: new Set([draft]),
    })

    const response = await remote.create({ sessionId: draft, cwd })

    expect(response).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    expect(ctx.agents.list()).toEqual([])
  })

  it('creates a new Session when the blank Session started after it was observed', async () => {
    const draft = SessionId('overtaken-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { ctx, remote, resumed } = await harness({
      presets: ['standard', 'minimal'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'minimal' }), events: [modelSelection(0)] }]]),
      writtenSinceObservation: new Map([[draft, completedTurn(1)]]),
    })

    const created = await remote.create({ sessionId: draft, cwd })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('overtaken-draft')
    expect(resumed).toEqual(['overtaken-draft'])
    expect(ctx.sessions.get(draft)).toBeUndefined()
  })

  it('refuses a stored Session in another directory', async () => {
    const other = SessionId('stored-other')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, resumed } = await harness({
      presets: ['standard'],
      stored: new Map([[other, { header: storedHeader(other, '/elsewhere'), events: [modelSelection(0)] }]]),
    })

    const response = await remote.create({ sessionId: other, cwd })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'session/conflict', details: { sessionId: 'stored-other', existingCwd: '/elsewhere' } },
    })
    expect(resumed).toEqual([])
  })

  it('leaves a stored subagent identity to subagent routing', async () => {
    const child = SessionId('stored-child')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, resumed } = await harness({
      presets: ['standard'],
      stored: new Map([[child, {
        header: storedHeader(child, cwd, { parentSession: SessionId('parent'), origin: 'subagent' }),
        events: [modelSelection(0)],
      }]]),
    })

    const response = await remote.create({ sessionId: child, cwd })

    expect(response).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    expect(resumed).toEqual([])
  })
})

describe('session.create Workspace placement', () => {
  it('reuses a blank member of the requested Workspace', async () => {
    const draft = SessionId('member-draft')
    const { remote } = await harness({ presets: ['standard'], workspace: { members: [draft], archived: [] } })
    await remote.create({ sessionId: draft })

    const reused = await remote.create({ sessionId: draft, workspaceId: WORKSPACE })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'member-draft' } })
  })

  it.each([
    { name: 'outside the Workspace', members: [], archived: [] },
    { name: 'archived', members: [SessionId('placed-draft')], archived: [SessionId('placed-draft')] },
  ])('creates a new Session instead of reusing a blank Session $name', async ({ members, archived }) => {
    const draft = SessionId('placed-draft')
    const { remote, selections, presetOf } = await harness({ presets: ['standard', 'minimal'], workspace: { members, archived } })
    await remote.create({ sessionId: draft, agentPreset: 'minimal' })

    const created = await remote.create({ sessionId: draft, workspaceId: WORKSPACE })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('placed-draft')
    expect(selections).toEqual([])
    expect(presetOf(draft)).toBe('minimal')
  })

  it('records the Workspace roots and reuses a blank member only while they match', async () => {
    const draft = SessionId('rooted-draft')
    const [first, second] = [0, 1].map(() => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-root-')))
      tempDirs.push(root)
      return root
    }) as [string, string]
    const { ctx, remote, workspace } = await harness({
      presets: ['standard'],
      workspace: { members: [draft], archived: [], additionalPaths: [first] },
    })
    await remote.create({ sessionId: draft, workspaceId: WORKSPACE })
    expect(ctx.sessions.get(draft)?.additionalPaths).toEqual([first])

    const reused = await remote.create({ sessionId: draft, workspaceId: WORKSPACE })
    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'rooted-draft' } })

    Object.assign(workspace, { additionalPaths: [first, second] })
    const created = await remote.create({ sessionId: draft, workspaceId: WORKSPACE })
    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('rooted-draft')
    expect(ctx.sessions.get(created.value.sessionId)?.additionalPaths).toEqual([first, second])
    expect(ctx.sessions.get(draft)?.additionalPaths).toEqual([first])
  })

  it('does not resume a stored blank Session that recorded other roots', async () => {
    const draft = SessionId('stored-rooted-draft')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const roots: SessionEvent = {
      type: 'workspace/roots', seq: SessionSeq(0), time: 1, ignorable: true, data: { additionalPaths: [tmpdir()] },
    }
    const { remote, resumed } = await harness({
      presets: ['standard'],
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [roots] }]]),
    })

    const created = await remote.create({ sessionId: draft, cwd })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value.sessionId).not.toBe('stored-rooted-draft')
    expect(resumed).toEqual([])
  })
})

describe('session.create execution worlds', () => {
  it('creates a new Session instead of moving a blank Session to another execution world', async () => {
    const { remote, selections, presetOf } = await harness({ presets: ['standard', 'remote'], worlds: new Set(['remote']) })
    await remote.create({ sessionId: SessionId('draft') })

    const created = await remote.create({ sessionId: SessionId('draft'), agentPreset: 'remote' })

    if (!created.ok) throw new Error(`create failed: ${created.error.message}`)
    expect(created.value).toMatchObject({ agentPreset: 'remote' })
    expect(created.value.sessionId).not.toBe('draft')
    expect(selections).toEqual([])
    expect(presetOf(SessionId('draft'))).toBe('standard')
  })

  it('refuses a world-owning preset in a Host Workspace, requested or the default', async () => {
    const requested = await harness({ presets: ['standard', 'remote'], worlds: new Set(['remote']) })
    await expect(requested.remote.create({ workspaceId: WORKSPACE, agentPreset: 'remote' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })

    const defaulted = await harness({ presets: ['remote'], worlds: new Set(['remote']) })
    await expect(defaulted.remote.create({ workspaceId: WORKSPACE }))
      .resolves.toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
  })
})

/** One-provider catalog whose models accept only the `low` and `high` efforts. */
class PoolAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Pool' }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(['astra', 'luna'].map(id => ({ provider: 'pool', id, name: id })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('low'),
      },
    })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    // Session creation never streams.
  }
}

/** Session-local permission table: `current` falls back to the Host default until `set`. */
function permissionTable() {
  const chosen = new WeakMap<Session, string>()
  return {
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    defaultPreset: 'workspace-write',
    current: (session: Session) => chosen.get(session) ?? 'workspace-write',
    set: (session: Session, name: string) => { chosen.set(session, name) },
  }
}

describe('agent preset Session defaults', () => {
  const arro: AgentPresetDefaults = {
    model: { provider: 'pool', model: 'astra', reasoningEffort: 'high' },
    permission: 'read-only',
  }
  const arroModel = { provider: 'pool', model: 'astra', reasoningEffort: 'high' }

  async function defaultsHarness(defaults: Record<string, AgentPresetDefaults>, options: HarnessOptions = {}) {
    const permissions = permissionTable()
    const booted = await harness({
      presets: ['standard', 'arro'],
      defaults,
      ...options,
      prepare: async (ctx) => {
        await ctx.plugin(LlmRuntime)
        ctx.llm.registerAdapter(['pool'], new PoolAdapter())
        ctx.provide('permissionPresets', permissions as never)
      },
    })
    const { ctx } = booted
    const sessionOf = (id: string): Session => {
      const session = ctx.sessions.get(SessionId(id))
      if (session === undefined) throw new Error(`missing session ${id}`)
      return session
    }
    /** Record a selection the way the preset registry does after its own checks. */
    const switchPreset = (id: string, agentPreset: string): void => {
      sessionOf(id).append('agent-preset/selected', { agentPreset })
      ctx.emit('agent-preset/selected', SessionId(id), agentPreset)
    }
    return { ...booted, permissions, sessionOf, pending: (id: string) => booted.pending(SessionId(id)), switchPreset }
  }

  it('starts a new Session on its preset defaults', async () => {
    const { remote, permissions, sessionOf, pending } = await defaultsHarness({ arro })

    await remote.create({ sessionId: SessionId('d1'), agentPreset: 'arro' })
    await remote.create({ sessionId: SessionId('d2'), agentPreset: 'standard' })

    expect(pending('d1')).toEqual(arroModel)
    expect(permissions.current(sessionOf('d1'))).toBe('read-only')
    expect(pending('d2')).toBeNull()
    expect(permissions.current(sessionOf('d2'))).toBe('workspace-write')
  })

  it('keeps an omitted default effort automatic', async () => {
    const { remote, pending } = await defaultsHarness({ arro: { model: { provider: 'pool', model: 'luna' } } })

    await remote.create({ sessionId: SessionId('d11'), agentPreset: 'arro' })

    expect(pending('d11')).toEqual({ provider: 'pool', model: 'luna' })
  })

  it('falls back to the Host defaults when a declared default is unusable', async () => {
    const { remote, permissions, sessionOf, pending } = await defaultsHarness({
      arro: { model: { provider: 'pool', model: 'astra', reasoningEffort: 'max' }, permission: 'yolo' },
      standard: { model: { provider: 'pool', model: 'gone' } },
    })

    const created = await remote.create({ sessionId: SessionId('d3'), agentPreset: 'arro' })
    await remote.create({ sessionId: SessionId('d4'), agentPreset: 'standard' })

    expect(created.ok).toBe(true)
    expect(pending('d3')).toBeNull()
    expect(permissions.current(sessionOf('d3'))).toBe('workspace-write')
    expect(pending('d4')).toBeNull()
  })

  it('applies the new preset defaults when a blank Session switches preset', async () => {
    const { remote, permissions, sessionOf, pending, switchPreset } = await defaultsHarness({ arro })
    await remote.create({ sessionId: SessionId('d5'), agentPreset: 'standard' })

    switchPreset('d5', 'arro')
    await vi.waitFor(() => { expect(permissions.current(sessionOf('d5'))).toBe('read-only') })
    expect(pending('d5')).toEqual(arroModel)

    switchPreset('d5', 'standard')
    await vi.waitFor(() => { expect(permissions.current(sessionOf('d5'))).toBe('workspace-write') })
    expect(pending('d5')).toEqual({ provider: 'test', model: 'test-model' })
  })

  it('moves a reused live blank Session to the requested preset defaults before responding', async () => {
    const { remote, permissions, sessionOf, pending } = await defaultsHarness({ arro })
    await remote.create({ sessionId: SessionId('d10'), agentPreset: 'standard' })

    const reused = await remote.create({ sessionId: SessionId('d10'), agentPreset: 'arro' })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'd10', agentPreset: 'arro' } })
    expect(permissions.current(sessionOf('d10'))).toBe('read-only')
    expect(pending('d10')).toEqual(arroModel)
  })

  it('moves a resumed stored blank Session to the requested preset defaults', async () => {
    const draft = SessionId('d12')
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-stored-')))
    tempDirs.push(cwd)
    const { remote, resumed, permissions, sessionOf, pending } = await defaultsHarness({ arro }, {
      stored: new Map([[draft, { header: storedHeader(draft, cwd, { agentPreset: 'standard' }), events: [modelSelection(0)] }]]),
    })

    const reused = await remote.create({ sessionId: draft, cwd, agentPreset: 'arro' })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'd12', agentPreset: 'arro' } })
    expect(resumed).toEqual(['d12'])
    expect(permissions.current(sessionOf('d12'))).toBe('read-only')
    expect(pending('d12')).toEqual(arroModel)
  })

  it('admits a text prompt sent right after a preset switch under the new defaults', async () => {
    const { ctx, remote, permissions, sessionOf, pending, switchPreset } = await defaultsHarness({ arro })
    await remote.create({ sessionId: SessionId('d9'), agentPreset: 'standard' })
    const seen: unknown[] = []
    Object.assign(ctx.agents.get(SessionId('d9')) as Agent, {
      inbox: { nextTurn: [], nextStep: [] },
      followup: () => { seen.push([permissions.current(sessionOf('d9')), pending('d9')]) },
    })

    switchPreset('d9', 'arro')
    await remote.prompt({ sessionId: SessionId('d9'), requestId: 'r1' as SessionRequestId, content: [{ type: 'text', text: 'go' }], mode: 'queue' })

    expect(seen).toEqual([['read-only', arroModel]])
  })

  it('keeps explicit model and permission choices across a preset switch', async () => {
    const { remote, permissions, sessionOf, pending, switchPreset } = await defaultsHarness({ arro })
    await remote.create({ sessionId: SessionId('d6'), agentPreset: 'standard' })
    await remote.create({ sessionId: SessionId('d7'), agentPreset: 'standard' })
    await remote.selectModel({ sessionId: SessionId('d6'), provider: 'pool', model: 'luna' })
    permissions.set(sessionOf('d7'), 'danger-full-access')

    switchPreset('d6', 'arro')
    switchPreset('d7', 'arro')

    await vi.waitFor(() => { expect(permissions.current(sessionOf('d6'))).toBe('read-only') })
    expect(pending('d6')).toEqual({ provider: 'pool', model: 'luna' })
    await vi.waitFor(() => { expect(pending('d7')).toEqual(arroModel) })
    expect(permissions.current(sessionOf('d7'))).toBe('danger-full-access')
  })

  it('leaves an existing Session untouched when its preset gains defaults', async () => {
    const defaults: Record<string, AgentPresetDefaults> = {}
    const { remote, permissions, sessionOf, pending } = await defaultsHarness(defaults)
    await remote.create({ sessionId: SessionId('d8'), agentPreset: 'arro' })
    defaults['arro'] = arro

    const reused = await remote.create({ sessionId: SessionId('d8'), agentPreset: 'arro' })

    expect(reused).toMatchObject({ ok: true, value: { sessionId: 'd8' } })
    expect(pending('d8')).toBeNull()
    expect(permissions.current(sessionOf('d8'))).toBe('workspace-write')
  })
})
