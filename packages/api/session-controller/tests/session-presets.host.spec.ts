/** Session creation and adoption rules for Agent preset identity. */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition, type AgentPresetDefaults } from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionTestRemote } from './test-remote.ts'

/** Booted contexts and their temp roots, torn down after each test. */
const contexts: Context[] = []
const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

function roster(ids: readonly string[], defaults: Record<string, AgentPresetDefaults> = {}): unknown {
  const presetOf = (id: string): object => ({
    id,
    trust: 'system',
    ...defaults[id] === undefined ? {} : { defaults: defaults[id] },
  })
  return {
    defaultId: ids[0],
    resolve: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      if (!ids.includes(wanted)) {
        return Promise.reject(new RemoteError(
          'agent-preset/not-found',
          `agent-presets: preset "${wanted}" not found (available: ${ids.join(', ') || 'none'})`,
          { agentPreset: wanted, available: ids },
        ))
      }
      return Promise.resolve(presetOf(wanted))
    },
    mount: (_ctx: Context, id?: string) => Promise.resolve(presetOf(id ?? ids[0] ?? '')),
    serviceForPreset: () => undefined,
  }
}

async function harness(
  presets?: readonly string[],
  defaults?: Record<string, AgentPresetDefaults>,
  prepare?: (ctx: Context) => Promise<void>,
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-session-preset-')))
  tempDirs.push(cwd)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (presets !== undefined) {
    ctx.provide('agentPresets', roster(presets, defaults) as never)
  }

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      ;(agent as { ctx?: Context }).ctx = ctx
      await options.setup?.(ctx, agent)
      const unregister = await ctx.agents.register(agent)
      return { agent, dispose: async () => { await unregister() } }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  await prepare?.(ctx)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
  })
  if (presets !== undefined) ctx.sessionProjections.register(agentPresetProjectionDefinition)
  return { ctx, remote }
}

describe('session.create Agent preset identity', () => {
  it('records the requested preset on the Session header', async () => {
    const { ctx, remote } = await harness(['standard', 'minimal'])

    const created = await remote.create({ sessionId: SessionId('s1'), agentPreset: 'minimal' })

    expect(created.ok).toBe(true)
    expect(ctx.sessions.get(SessionId('s1'))?.header.agentPreset).toBe('minimal')
  })

  it('records the roster default when the caller names no preset', async () => {
    const { ctx, remote } = await harness(['standard', 'minimal'])

    await remote.create({ sessionId: SessionId('s2') })

    expect(ctx.sessions.get(SessionId('s2'))?.header.agentPreset).toBe('standard')
  })

  it('rejects an unknown preset', async () => {
    const { remote } = await harness(['standard'])

    const response = await remote.create({ sessionId: SessionId('s3'), agentPreset: 'nope' })

    expect(response).toMatchObject({ ok: false, error: { code: 'agent-preset/not-found' } })
  })

  it('refuses to adopt a live Session under a different preset', async () => {
    const { remote } = await harness(['standard', 'minimal'])
    await remote.create({ sessionId: SessionId('s4'), agentPreset: 'minimal' })

    const response = await remote.create({ sessionId: SessionId('s4'), agentPreset: 'standard' })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'agent-preset/conflict',
        details: {
          sessionId: 's4',
          requestedPreset: 'standard',
          existingPreset: 'minimal',
        },
      },
    })
  })

  it('adopts a live Session under the preset selected in its log', async () => {
    const { ctx, remote } = await harness(['standard', 'minimal'])
    await remote.create({ sessionId: SessionId('s4b'), agentPreset: 'standard' })
    ctx.sessions.get(SessionId('s4b'))?.append('agent-preset/selected', { agentPreset: 'minimal' })

    const adopted = await remote.create({ sessionId: SessionId('s4b'), agentPreset: 'minimal' })
    const stale = await remote.create({ sessionId: SessionId('s4b'), agentPreset: 'standard' })

    expect(adopted).toMatchObject({ ok: true, value: { agentPreset: 'minimal' } })
    expect(stale).toMatchObject({
      ok: false,
      error: { details: { existingPreset: 'minimal' } },
    })
  })

  it('adopts a live Session unchanged when the caller names no preset', async () => {
    const { remote } = await harness(['standard', 'minimal'])
    await remote.create({ sessionId: SessionId('s5'), agentPreset: 'minimal' })

    await expect(remote.create({ sessionId: SessionId('s5') }))
      .resolves.toMatchObject({ ok: true })
  })

  it('leaves the header preset-less when no roster is composed', async () => {
    const { ctx, remote } = await harness()

    await remote.create({ sessionId: SessionId('s6') })

    expect(ctx.sessions.get(SessionId('s6'))?.header.agentPreset).toBeUndefined()
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
    expect(response.error.message).toContain('records no agent preset')
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

  async function defaultsHarness(defaults: Record<string, AgentPresetDefaults>) {
    const { ctx, remote } = await harness(['standard', 'arro'], defaults, async (ctx) => {
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['pool'], new PoolAdapter())
    })
    const permissions = permissionTable()
    ctx.provide('permissionPresets', permissions as never)
    const sessionOf = (id: string): Session => {
      const session = ctx.sessions.get(SessionId(id))
      if (session === undefined) throw new Error(`missing session ${id}`)
      return session
    }
    const pending = (id: string) => ctx.sessionProjections.stateOf(sessionOf(id), 'modelSelection')?.pending ?? null
    const switchPreset = (id: string, agentPreset: string): void => {
      sessionOf(id).append('agent-preset/selected', { agentPreset })
      ctx.emit('agent-preset/selected', SessionId(id), agentPreset)
    }
    return { ctx, remote, permissions, sessionOf, pending, switchPreset }
  }

  it('starts a new Session on its preset defaults', async () => {
    const { remote, permissions, sessionOf, pending } = await defaultsHarness({ arro })

    await remote.create({ sessionId: SessionId('d1'), agentPreset: 'arro' })
    await remote.create({ sessionId: SessionId('d2'), agentPreset: 'standard' })

    expect(pending('d1')).toEqual({ provider: 'pool', model: 'astra', reasoningEffort: 'high' })
    expect(permissions.current(sessionOf('d1'))).toBe('read-only')
    expect(pending('d2')).toBeNull()
    expect(permissions.current(sessionOf('d2'))).toBe('workspace-write')
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
    expect(pending('d5')).toEqual({ provider: 'pool', model: 'astra', reasoningEffort: 'high' })

    switchPreset('d5', 'standard')
    await vi.waitFor(() => { expect(permissions.current(sessionOf('d5'))).toBe('workspace-write') })
    expect(pending('d5')).toEqual({ provider: 'test', model: 'test-model' })
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
    expect(pending('d6')).toEqual({ provider: 'pool', model: 'luna', reasoningEffort: 'low' })
    await vi.waitFor(() => { expect(pending('d7')).toEqual({ provider: 'pool', model: 'astra', reasoningEffort: 'high' }) })
    expect(permissions.current(sessionOf('d7'))).toBe('danger-full-access')
  })

  it('leaves an existing Session untouched when its preset gains defaults', async () => {
    const defaults: Record<string, AgentPresetDefaults> = {}
    const { remote, permissions, sessionOf, pending } = await defaultsHarness(defaults)
    await remote.create({ sessionId: SessionId('d8'), agentPreset: 'arro' })
    defaults['arro'] = arro

    const adopted = await remote.create({ sessionId: SessionId('d8'), agentPreset: 'arro' })

    expect(adopted.ok).toBe(true)
    expect(pending('d8')).toBeNull()
    expect(permissions.current(sessionOf('d8'))).toBe('workspace-write')
  })
})
