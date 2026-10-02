/**
 * Workflow orchestration through the shared sandboxed Node PTC executor.
 * The VM supplies script helpers; the process applies the calling Session's file policy.
 * @module @deepseek-ai/dsh-workflow-ptc
 */

import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import * as vm from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import z from '@deepseek-ai/schemastery'
import WorkflowEngine, { WorkflowError, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowRun, WorkflowRunInfo, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import { subagentModelSelectionPolicy } from '@deepseek-ai/dsh-tool-subagent/route-selection'
import { PtcWorkflowRun } from './host.ts'
import { validateMeta } from './meta.ts'
import type { WorkerInit, WorkerLimits } from './types.ts'

export { validateMeta } from './meta.ts'
export { materializeFromRealm, MaterializeError } from './realm.ts'
export type {
  ChildHandle,
  ChildPort,
  ChildResult,
  ChildStartRequest,
  WorkerInit,
  WorkerLimits,
} from './types.ts'

/**
 * LLM route defaults for every `agent()` child. Provider and model form one
 * route and are configured together.
 */
export interface ChildAgentDefaults {
  /** LLM provider id of the child route. */
  provider?: string
  /** Model id interpreted by `provider`. */
  model?: string
  /** Adapter-owned reasoning effort; checked against the effective route before each child starts. */
  reasoningEffort?: string
  /** Positive output-token limit per child request. */
  maxTokens?: number
}

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** The `ctx.subagents` provider children run on (default `spawn`). */
  provider?: string
  /**
   * Route defaults for every `agent()` child whose subagent provider can
   * apply a route (`agentOptions` capability); omitted fields inherit the
   * parent's route. A call's own provider, model or reasoning effort
   * overrides them, and a call that changes the route without naming an
   * effort drops the configured effort.
   */
  agentOptions?: ChildAgentDefaults | undefined
  /** Concurrent `agent()` ceiling; `0` (the default) auto-resolves to `min(16, max(1, cores - 2))`. */
  maxConcurrentAgents?: number
  /** Total `agent()` calls one run may start — the runaway-loop backstop (default 1000). */
  maxTotalAgents?: number
  /** Items accepted by a single `parallel()`/`pipeline()` call (default 4096). */
  maxItemsPerCall?: number
  /** VM timeout for the script's initial synchronous slice (default 5000 ms). */
  syncTimeoutMs?: number
}

type ResolvedConfig = Required<Omit<Config, 'agentOptions'>> & Pick<Config, 'agentOptions'>

/**
 * Convert configured child defaults into Agent options.
 * @param defaults - the configured defaults, if any.
 * @returns the Agent options, or undefined when nothing is configured.
 * @throws when only one of provider and model is configured.
 */
function childAgentDefaults(defaults: ChildAgentDefaults | undefined): AgentOptions | undefined {
  if (defaults === undefined) return undefined
  if ((defaults.provider === undefined) !== (defaults.model === undefined)) {
    throw new Error('workflow-ptc: configure `agentOptions.provider` and `agentOptions.model` together')
  }
  return {
    ...defaults.provider === undefined ? {} : { provider: defaults.provider },
    ...defaults.model === undefined ? {} : { model: defaults.model },
    ...defaults.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(defaults.reasoningEffort) },
    ...defaults.maxTokens === undefined ? {} : { maxTokens: defaults.maxTokens },
  }
}

/** A body that still carries the Claude Code-style meta header (meta rides the seam as data here). */
const META_STATEMENT = /^\s*export\s+const\s+meta\b/

/**
 * Reject invalid JavaScript synchronously before publishing a workflow run.
 * The guest compiles the same async wrapper in its own process.
 */
function assertBodyParses(body: string, name: string): void {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError('workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body', 'SCRIPT_PARSE')
  }
  try {
    // Parse only — the script object is discarded, nothing executes.
    void new vm.Script(`(async () => {\n${body}\n})()`, { filename: `workflow:${name}`, lineOffset: -1 })
  } catch (error: unknown) {
    throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
  }
}

/** Resolve one run's provider route before publishing work. */
function resolveSubagentProvider(ctx: Context, configured: string, override: string | undefined): string {
  const provider = override ?? configured
  if (provider.length === 0 || provider !== provider.trim()) {
    throw new WorkflowError(
      'workflow subagentProvider must be a non-empty normalized string',
      'INVALID_ARGUMENT',
    )
  }
  if (ctx.subagents.getProvider(provider) === undefined) {
    throw new WorkflowError(`no subagent provider registered for "${provider}"`, 'AGENT_START')
  }
  return provider
}

/** Resolve one run's total-child cap against the engine deployment ceiling. */
function resolveMaxTotalAgents(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new WorkflowError('workflow maxTotalAgents must be a positive safe integer', 'INVALID_ARGUMENT')
  }
  if (requested > ceiling) {
    throw new WorkflowError(
      `workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}`,
      'INVALID_ARGUMENT',
    )
  }
  return requested
}

/**
 * The PTC-backed workflow engine. `start()` validates the script up front
 * (meta + a host-side body parse) and returns a {@link WorkflowRun} whose
 * `result` never rejects; the `workflow/*` events fire around the run per
 * the seam contract.
 */
class PtcWorkflowEngine extends WorkflowEngine {
  static inject = ['subagents', 'ptcRuntime', 'sandboxPolicy', 'sessionProjections']

  static Config: z<Config> = z.object({
    provider: z.string().default('spawn'),
    // A union keeps an omitted field absent instead of an empty object.
    agentOptions: z.union([z.const(undefined), z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      reasoningEffort: z.string().min(1),
      maxTokens: z.natural().min(1),
    })]),
    maxConcurrentAgents: z.natural().default(0),
    maxTotalAgents: z.natural().min(1).default(1000),
    maxItemsPerCall: z.natural().min(1).default(4096),
    syncTimeoutMs: z.natural().min(1).default(5000),
  })

  private readonly config: ResolvedConfig
  private readonly childDefaults: AgentOptions | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (ctx.ptcRuntime.language !== 'typescript') throw new Error('workflow-ptc requires the Node TypeScript PTC runtime')
    // schemastery (static Config) has already filled the defaulted fields;
    // the assertion records that resolution, not a hidden fallback.
    this.config = config as ResolvedConfig
    this.childDefaults = childAgentDefaults(config.agentOptions)
  }

  /**
   * Validate and execute a workflow script in a sandboxed Node process. Throws
   * {@link WorkflowError} synchronously (`META_INVALID` for a malformed meta
   * block, `SCRIPT_PARSE` for a body that does not compile) for a request
   * that cannot begin; once a run is returned, every failure resolves through
   * `result.stopReason` instead.
   * @param request - the script body, its meta data and `args`, the parent
   *   agent, and an optional cancel signal.
   * @returns the live run (its `result` resolves when the script settles).
   */
  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta)
    assertBodyParses(request.script, meta.name)
    const subagentProvider = resolveSubagentProvider(this.ctx, this.config.provider, request.subagentProvider)
    const maxTotalAgents = resolveMaxTotalAgents(request.maxTotalAgents, this.config.maxTotalAgents)
    const id = WorkflowRunId(randomUUID())
    const info: WorkflowRunInfo = { id, meta }
    const limits: WorkerLimits = {
      maxConcurrentAgents: this.config.maxConcurrentAgents === 0
        ? Math.min(16, Math.max(1, availableParallelism() - 2))
        : this.config.maxConcurrentAgents,
      maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
      syncTimeoutMs: this.config.syncTimeoutMs,
    }
    const init: WorkerInit = {
      meta,
      body: request.script,
      ...request.args !== undefined ? { args: structuredClone(request.args) } : {},
      limits,
    }
    // Captured service handles keep a holder-owned run usable after engine unload.
    const runCtx = this.ctx
    const subagents = runCtx.subagents
    const run = new PtcWorkflowRun(
      runCtx,
      subagents,
      runCtx.ptcRuntime,
      id,
      meta,
      request.parent,
      init,
      subagentProvider,
      this.childDefaults,
      // The policy is recorded once per Session, so the run start reads it.
      subagentModelSelectionPolicy(runCtx.sessionProjections, request.parent.session),
      runCtx.sandboxPolicy.resolve({ session: request.parent.session }),
      {
        phase: (title) => { this.emitWorkflowEvent('workflow/phase', info, title) },
        log: (message) => { this.emitWorkflowEvent('workflow/log', info, message) },
        agentStart: (agent) => { this.emitWorkflowEvent('workflow/agent-start', info, agent) },
        agentEnd: (agent) => { this.emitWorkflowEvent('workflow/agent-end', info, agent) },
      },
      request.signal,
    )

    this.emitWorkflowEvent('workflow/start', info)
    // `workflow/end` fires as the (never-rejecting) result settles, with the
    // outcome DATA only — the value stays with the run's holder.
    void run.result.then((settled) => {
      this.emitWorkflowEvent('workflow/end', info, {
        stopReason: settled.stopReason,
        ...settled.error !== undefined ? { error: settled.error } : {},
        agentsStarted: settled.agentsStarted,
      })
    })

    return run
  }
}

export default PtcWorkflowEngine
