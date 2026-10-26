/** Agent activation, composition, and initial model route owned by API Session. */

import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent, AgentOptions, AgentSetup, ModelSelection as AgentModelSelection,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentPresetDefaults } from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { modelAvailable } from './catalog.ts'

/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** Reuse of a Session named an Agent preset while the deployment composes no preset roster. */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
  ) {
    super(`the deployment composes no agent preset roster, so session "${sessionId}" cannot run preset "${requestedPreset}"`)
  }
}

/** A blank Session chosen for reuse started a turn before this Host acquired its writer. */
class ApiSessionStartedSinceObserved extends Error {}

/** Placement and Agent preset for one Session created for a new conversation. */
export interface ApiSessionCreateRequest {
  /** Blank Session to reuse, or the identity of a new Session when none is stored under it. */
  readonly sessionId?: SessionId
  /** Directory the Session owns. */
  readonly cwd: string
  /** Preset the Session runs; the configured default when omitted. */
  readonly agentPreset?: string
  /**
   * Existing directories a new Session records beside `cwd`, fixed at
   * creation; a named Session that recorded other roots is not reused.
   */
  readonly additionalPaths?: readonly string[]
  /**
   * Placement rule the caller owns, such as Workspace membership and archive state.
   * @param sessionId - existing Session named by the request.
   * @returns whether that Session may be reused.
   */
  readonly reusable: (sessionId: SessionId) => boolean
}

/** The Session one creation request created or reused. */
export interface ApiSessionCreated {
  /** Live Agent of the Session. */
  readonly agent: Agent
  /** Preset the Session ran when the request finished, before a later request for the same identity; absent without a roster. */
  readonly agentPreset: string | undefined
}

/** Resolved preset and pre-publication Agent setup for one create or resume. */
interface ApiSessionComposition {
  readonly agentPreset?: string
  readonly setup: AgentSetup
}

/** Preset defaults that passed validation; an omitted field leaves the Host default in place. */
interface InitialChoices {
  readonly model?: AgentModelSelection
  readonly permission?: string
}

/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'session/writer-held' | 'gateway/internal'>

/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param ctx - Host context carrying the Agent ownership registry.
 * @param session - attached or live Session whose ownership is tested.
 * @param agent - live Agent when one exists for the Session.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly claims = new Map<SessionId, Promise<void>>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()
  /** Preset each Agent composed here was last bound to, so a blank-Session switch knows the replaced defaults. */
  private readonly boundPresets = new WeakMap<Agent, string>()

  /** @param ctx - Host context carrying Agent, model, persistence, and Typert services. */
  constructor(private readonly ctx: Context) {}

  /**
   * Configure Session and Agent lookups for Typert, and move a blank Session's
   * preset defaults along with each later preset selection.
   */
  initialize(): void {
    const ctx = this.ctx
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
    ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
      const agent = ctx.agents.get(sessionId)
      const previous = agent === undefined ? undefined : this.boundPresets.get(agent)
      if (agent === undefined || previous === undefined || previous === agentPreset) return
      this.boundPresets.set(agent, agentPreset)
      void this.switchPresetDefaults(agent, previous, agentPreset)
    })
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation)
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
  ): Promise<ApiSessionAgentResult> {
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      const agent = await resume
      // A shared resume can publish an identity that subagent routing adopts
      // before every waiter observes it; apply the live ownership policy again.
      const published = this.liveAgent(sessionId)
      return published ?? { agent }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) return raced
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { error: new RemoteError('session/writer-held', error.message, { sessionId }) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * Create a Session for a new conversation, reusing the named blank Session
   * while it is still reusable. A reused Session runs the requested preset, or
   * the configured default when the request names none; the preset it recorded
   * is not resolved, and a change is logged as `agent-preset/selected` before
   * the Agent is published. A named Session that has started a turn, fails the
   * caller's placement rule, or is written by another owner stays unchanged,
   * and a new Session is created instead. Requests naming one identity run in
   * arrival order, including their preset resolution, and check the named
   * Session's directory and ownership before resolving the preset. A named
   * Session is reused only while it records the requested additional roots
   * and its preset runs in the same execution world as the requested one; a
   * reused Session's model and permission follow the new preset's defaults
   * where they still equal the replaced preset's. A new Session starts with
   * its preset's validated defaults.
   * @param request - optional Session to reuse, directory, roots, preset, and placement rule.
   * @returns the reused or created Session and the preset it ran when this request finished.
   * @throws ApiSessionCwdConflict when the named Session belongs to another directory.
   * @throws ApiSessionSubagentOwnership when subagent routing owns the named Session.
   * @throws RemoteError `agent-preset/not-found` or `agent-preset/invalid` for the requested or default preset.
   * @throws ApiSessionPresetConflict when no roster is composed and the request names a preset for a reused Session.
   */
  async createSession(request: ApiSessionCreateRequest): Promise<ApiSessionCreated> {
    const named = request.sessionId
    if (named === undefined) {
      return this.created(await this.createMinted(request, await this.composeAgent(request.agentPreset)))
    }
    return this.inOrder(named, async () => this.created(await this.claim(named, request)))
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined without a preset service or recorded selection.
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.get('agentPresets')?.presetForSession(session) ?? undefined
  }

  /**
   * Serialize prompt admission, model selection, and preset-default switches for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<ApiSessionComposition> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return { setup: (agentCtx) => { installModelSelection(agentCtx) } }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        installModelSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
        this.boundPresets.set(agent, resolvedId)
      },
    }
  }

  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(sessionId: SessionId, supplied?: SessionObservation): Promise<Agent> {
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied)
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return await this.resumeObserved(sessionId, observation)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
  ): Promise<Agent> {
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    return (await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })).agent
  }

  private async inOrder<Value>(sessionId: SessionId, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.claims.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.claims.set(sessionId, settled)
    try {
      return await result
    } finally {
      if (this.claims.get(sessionId) === settled) this.claims.delete(sessionId)
    }
  }

  /** @returns the reused Session, a new Session under `sessionId` when none is stored, or a new Session under a minted identity. */
  private async claim(sessionId: SessionId, request: ApiSessionCreateRequest): Promise<Agent> {
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) {
      if (live.session.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(live.id, request.cwd, live.session.header.cwd)
      }
      const composition = await this.composeAgent(request.agentPreset)
      return await this.reuseLive(live, request, composition) ?? this.createMinted(request, composition)
    }
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId)
    } catch (error: unknown) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      return this.createAgent(sessionId, request, await this.composeAgent(request.agentPreset))
    }
    let reusable: boolean
    let recordedPreset: string | undefined
    {
      using observed = observation
      if (hasApiSessionSubagentOwner(this.ctx, { header: observed.header }, undefined)) {
        throw new ApiSessionSubagentOwnership(sessionId)
      }
      if (observed.header.cwd !== request.cwd) {
        throw new ApiSessionCwdConflict(sessionId, request.cwd, observed.header.cwd)
      }
      reusable = request.reusable(sessionId)
        && !observed.events.some(event => event.type === 'turn/start')
        && sameRoots(recordedRoots(observed.events), request.additionalPaths ?? [])
      recordedPreset = reusable && this.ctx.get('agentPresets') !== undefined ? this.presetForObservation(observed) : undefined
    }
    const composition = await this.composeAgent(request.agentPreset)
    if (!reusable || !this.sameWorld(recordedPreset, composition.agentPreset)) return this.createMinted(request, composition)
    this.assertPresetApplicable(sessionId, request.agentPreset)
    const switched: { replaced?: { readonly agentPreset: string | undefined } } = {}
    let agent: Agent
    try {
      agent = (await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions(),
        setup: this.reuseSetup(composition, switched),
      })).agent
    } catch (error: unknown) {
      if (error instanceof ApiSessionStartedSinceObserved) return this.createMinted(request, composition)
      if (!(error instanceof Error) || error.name !== 'SessionAlreadyOwnedError') throw error
      // Another resume in this process may hold the writer for the Agent it published.
      return this.ctx.agents.get(sessionId) === undefined
        ? this.createMinted(request, composition)
        : this.claim(sessionId, request)
    }
    const target = composition.agentPreset
    if (switched.replaced !== undefined && target !== undefined) {
      await this.switchPresetDefaults(agent, switched.replaced.agentPreset, target)
    }
    return agent
  }

  /** @returns the live blank Session under the requested preset, or undefined when it cannot be reused. */
  private async reuseLive(
    live: Agent,
    request: ApiSessionCreateRequest,
    composition: ApiSessionComposition,
  ): Promise<Agent | undefined> {
    if (!request.reusable(live.id) || !this.isBlank(live.session)) return undefined
    if (!sameRoots(live.session.additionalPaths, request.additionalPaths ?? [])) return undefined
    const current = this.presetForSession(live.session)
    if (!this.sameWorld(current, composition.agentPreset)) return undefined
    this.assertPresetApplicable(live.id, request.agentPreset)
    const presets = this.ctx.get('agentPresets')
    const target = composition.agentPreset
    if (presets === undefined || target === undefined || target === current) return live
    try {
      await presets.select(live, target)
    } catch (error: unknown) {
      if (remoteErrorOf(error)?.code !== 'agent-preset/locked') throw error
      return undefined
    }
    // The selection queued the preset-default switch; return once it has applied.
    await this.serializeImageAdmission(live, () => Promise.resolve())
    return live
  }

  /**
   * Setup that re-checks blankness under the acquired writer, then records a preset change before publication.
   * @param composition - preset and setup the reused Session runs.
   * @param switched - receives the replaced preset when the change is recorded, so the caller can move its defaults after publication.
   * @returns the reuse setup.
   */
  private reuseSetup(
    composition: ApiSessionComposition,
    switched: { replaced?: { readonly agentPreset: string | undefined } },
  ): AgentSetup {
    return async (agentCtx, agent) => {
      if (!this.isBlank(agent.session)) throw new ApiSessionStartedSinceObserved()
      const commit = await composition.setup(agentCtx, agent)
      const target = composition.agentPreset
      const recorded = this.presetForSession(agent.session)
      if (target !== undefined && recorded !== target) {
        agent.session.append('agent-preset/selected', { agentPreset: target })
        switched.replaced = { agentPreset: recorded }
      }
      return commit
    }
  }

  /**
   * Whether two presets run in the same execution world: the Host, or the
   * world a preset's own composition declares (for example an SSH host).
   * @param left - recorded preset, if any.
   * @param right - requested preset, if any.
   * @returns false when a blank Session would move to another world.
   */
  private sameWorld(left: string | undefined, right: string | undefined): boolean {
    const presets = this.ctx.get('agentPresets')
    const worldOf = (id: string | undefined): string | undefined =>
      id !== undefined && presets?.ownsWorld(id) === true ? id : undefined
    return worldOf(left) === worldOf(right)
  }

  /** Whether no turn has started, by the predicate the preset registry's `select` enforces. */
  private isBlank(session: Session): boolean {
    const boundary = this.ctx.agents.turnBoundaryOf(session)
    return boundary.openTurnStartSeq === null && boundary.lastTurn === 0
  }

  /** Without a roster, reuse cannot apply a named preset. */
  private assertPresetApplicable(sessionId: SessionId, requested: string | undefined): void {
    if (requested === undefined || this.ctx.get('agentPresets') !== undefined) return
    throw new ApiSessionPresetConflict(sessionId, requested)
  }

  private created(agent: Agent): ApiSessionCreated {
    return { agent, agentPreset: this.presetForSession(agent.session) }
  }

  private createMinted(request: ApiSessionCreateRequest, composition: ApiSessionComposition): Promise<Agent> {
    return this.createAgent(brandString<SessionId>(`session-${randomUUID()}`), request, composition)
  }

  /**
   * Create a Session in its preset's execution world, starting from the preset's validated defaults.
   * @param sessionId - identity of the new Session.
   * @param request - directory and additional roots the Session records.
   * @param composition - resolved preset and Agent setup.
   * @returns the published Agent.
   */
  private async createAgent(
    sessionId: SessionId,
    request: ApiSessionCreateRequest,
    composition: ApiSessionComposition,
  ): Promise<Agent> {
    const { cwd } = request
    const additionalPaths = request.additionalPaths ?? []
    await this.ensureProjectDirectories(cwd, additionalPaths, composition.agentPreset)
    const initial = await this.initialChoices(composition.agentPreset)
    const model = initial.model
    const { agent } = await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...(additionalPaths.length === 0 ? {} : { additionalPaths }),
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      // The preset's model is recorded before publication, so resume keeps it.
      setup: model === undefined ? composition.setup : async (agentCtx, created) => {
        const commit = await composition.setup(agentCtx, created)
        created.model.select(model)
        return commit
      },
    })
    if (initial.permission !== undefined) this.applyInitialChoices(agent, { permission: initial.permission }, {})
    return agent
  }

  /**
   * Ensure a new Session's directories in the execution world its preset
   * selects. A preset that owns its world (for example over SSH) checks the
   * cwd through that world's `fs`, refuses while that provider is missing, and
   * never creates anything on the Host. Otherwise the Host cwd is created when
   * missing. Additional roots are recorded permanently, so each must already
   * be a directory in that world.
   * @param cwd - requested project directory.
   * @param additionalPaths - additional workspace roots recorded beside `cwd`.
   * @param agentPreset - resolved preset identity, when presets are configured.
   */
  private async ensureProjectDirectories(
    cwd: string,
    additionalPaths: readonly string[],
    agentPreset: string | undefined,
  ): Promise<void> {
    const presets = this.ctx.get('agentPresets')
    const fs = agentPreset === undefined ? undefined : presets?.serviceForPreset(agentPreset, 'fs')
    if (fs === undefined && agentPreset !== undefined && presets?.ownsWorld(agentPreset) === true) {
      throw new Error(`failed to ensure project directory "${cwd}": the execution world of agent preset "${agentPreset}" is not available`)
    }
    const isDirectory = async (path: string): Promise<boolean> => fs === undefined
      ? (await stat(path)).isDirectory()
      : (await fs.stat(await fs.resolve(path)))?.type === 'directory'
    try {
      if (fs === undefined) await mkdir(cwd, { recursive: true })
      else if (!await isDirectory(cwd)) throw new Error(`not a directory in the execution world of agent preset "${agentPreset}"`)
    } catch (error: unknown) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    for (const path of additionalPaths) {
      let directory: boolean
      try {
        directory = await isDirectory(path)
      } catch (error: unknown) {
        throw new Error(`additional workspace path "${path}" is unavailable: ${String(error)}`, { cause: error })
      }
      if (!directory) throw new Error(`additional workspace path "${path}" is not a directory`)
    }
  }

  private agentOptions(): AgentOptions {
    const defaults = this.ctx.agentDefaultModel
    // A Session that records no selection or request follows default changes.
    return {
      get provider() { return defaults.currentSelection().provider },
      get model() { return defaults.currentSelection().model },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
    }
  }

  /**
   * Validate one preset's declared Session defaults against the current catalog
   * and permission table. A model must pass the checks `/model` applies; its
   * omitted effort stays automatic. An unusable value is logged without
   * provider error text and omitted, so the Host default applies and creation
   * never fails.
   * @param presetId - preset whose declaration is read; undefined without a roster.
   * @returns the usable defaults.
   */
  private async initialChoices(presetId: string | undefined): Promise<InitialChoices> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined || presetId === undefined) return {}
    let defaults: AgentPresetDefaults | undefined
    try {
      defaults = (await presets.resolve(presetId)).defaults
    } catch {
      // A preset removed since the Session bound it declares nothing any more.
      return {}
    }
    let model: AgentModelSelection | undefined
    const declared = defaults?.model
    if (declared !== undefined) {
      try {
        const requested: AgentModelSelection = {
          provider: declared.provider,
          model: declared.model,
          ...(declared.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(declared.reasoningEffort) }),
        }
        if (!await modelAvailable(this.ctx, requested)) throw new Error('not in the model catalog')
        await this.ctx.llm.resolveCallConfig(requested)
        model = requested
      } catch {
        this.ctx.logger.warn(`session-controller: agent preset "${presetId}" default model "${declared.provider}/${declared.model}" is unavailable or rejects its effort; using the Host default model`)
      }
    }
    const permission = defaults?.permission
    const known = permission !== undefined && this.ctx.get('permissionPresets')?.names.includes(permission) === true
    if (permission !== undefined && !known) {
      this.ctx.logger.warn(`session-controller: agent preset "${presetId}" default permission "${permission}" is not an available permission preset; using the Host default`)
    }
    return { ...(model === undefined ? {} : { model }), ...(known ? { permission } : {}) }
  }

  /**
   * Move a blank Session's model and permission to `next` wherever each still
   * equals what `replaced` chose, so an explicit `/model` or permission choice
   * stays. Changes are recorded through the same events those commands append.
   * @param agent - live blank Agent.
   * @param next - defaults now in force; an omitted field means the Host default.
   * @param replaced - defaults the Session was created or last switched under.
   */
  private applyInitialChoices(agent: Agent, next: InitialChoices, replaced: InitialChoices): void {
    const hostModel = this.ctx.agentDefaultModel.currentSelection()
    const model = next.model ?? (replaced.model === undefined ? undefined : hostModel)
    const current = agent.model.current()
    if (model !== undefined && sameSelection(current, replaced.model ?? hostModel) && !sameSelection(current, model)) {
      agent.model.select(model)
    }
    const permissions = this.ctx.get('permissionPresets')
    if (permissions === undefined) return
    const permission = next.permission ?? permissions.defaultPreset
    const currentPermission = permissions.current(agent.session)
    if (currentPermission !== permission && currentPermission === (replaced.permission ?? permissions.defaultPreset)) {
      permissions.set(agent.session, permission)
    }
  }

  /**
   * Queue a blank Session's move from one preset's defaults to another's
   * behind the Agent's earlier admissions; a failure is logged.
   * @param agent - live Agent whose preset changed.
   * @param previous - preset the Session ran before, if any.
   * @param next - preset the Session runs now.
   * @returns when the switch has applied or was skipped.
   */
  private switchPresetDefaults(agent: Agent, previous: string | undefined, next: string): Promise<void> {
    return this.serializeImageAdmission(agent, async () => {
      const [replaced, chosen] = await Promise.all([this.initialChoices(previous), this.initialChoices(next)])
      if (!this.isBlank(agent.session)) return
      this.applyInitialChoices(agent, chosen, replaced)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`session-controller: agent preset "${next}" defaults were not applied to session "${agent.id}": ${String(error)}`)
    })
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }
}

function sameSelection(
  left: Readonly<AgentModelSelection> | undefined,
  right: Readonly<AgentModelSelection> | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : left.provider === right?.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/** Additional roots a Session recorded at creation, from its seq-0 `workspace/roots` event. */
function recordedRoots(events: readonly SessionEvent[]): readonly string[] {
  const first = events[0]
  return first?.type === 'workspace/roots' ? first.data.additionalPaths : []
}

function sameRoots(left: readonly string[], right: readonly string[]): boolean {
  const recorded = new Set(left)
  return recorded.size === new Set(right).size && right.every(path => recorded.has(path))
}
