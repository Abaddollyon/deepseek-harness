/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeammateRoute, TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
  subagentModelSelectionPolicy,
} from '@deepseek-ai/dsh-tool-subagent/route-selection'
import type { DelegationModelRequest } from '@deepseek-ai/dsh-tool-subagent/route-selection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'subagents', 'sessionProjections', 'llm']

/**
 * LLM route defaults for every teammate. Provider and model form one route
 * and are configured together.
 */
export interface TeammateDefaults {
  /** LLM provider id of the teammate route. */
  readonly provider?: string
  /** Model id interpreted by `provider`. */
  readonly model?: string
  /** Adapter-owned reasoning effort; checked against the effective route before each teammate starts. */
  readonly reasoningEffort?: string
  /** Positive output-token limit per teammate request. */
  readonly maxTokens?: number
}

/** Tool routing configuration. */
export interface Config {
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
  /**
   * Route defaults for every teammate; omitted fields follow the subagent
   * provider's route defaults and the Lead's route. A `spawn_teammate` call's
   * own provider, model or reasoning effort overrides them, and a call that
   * changes the route without naming an effort drops the configured effort.
   */
  readonly agentOptions?: TeammateDefaults | undefined
}

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
  // A union keeps an omitted field absent instead of an empty object.
  agentOptions: z.union([z.const(undefined), z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
    maxTokens: z.natural().min(1),
  })]),
})

/** Resolved plugin configuration. */
interface ResolvedConfig {
  readonly freshProvider: string
  readonly forkProvider: string
  readonly agentOptions: AgentOptions | undefined
}

/**
 * Convert configured teammate defaults into Agent options.
 * @param defaults - the configured defaults, if any.
 * @returns the Agent options, or undefined when nothing is configured.
 * @throws when only one of provider and model is configured.
 */
function teammateDefaults(defaults: TeammateDefaults | undefined): AgentOptions | undefined {
  if (defaults === undefined) return undefined
  if ((defaults.provider === undefined) !== (defaults.model === undefined)) {
    throw new Error('tool-agent-team: configure `agentOptions.provider` and `agentOptions.model` together')
  }
  return {
    ...defaults.provider === undefined ? {} : { provider: defaults.provider },
    ...defaults.model === undefined ? {} : { model: defaults.model },
    ...defaults.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(defaults.reasoningEffort) },
    ...defaults.maxTokens === undefined ? {} : { maxTokens: defaults.maxTokens },
  }
}

/** Pointer appended to a rejected route choice. */
const ROUTE_HINT = ' Call list_subagent_models to see the routes and reasoning efforts you may choose.'

/**
 * Resolve and check one teammate's LLM route the way the subagent tool checks
 * a child's: provider and model together, an explicit choice limited to the
 * Session's allowed routes, and the effective route and effort resolved by
 * the live adapter before the teammate exists.
 * @param ctx - the plugin Context.
 * @param lead - the calling Team Lead.
 * @param providerName - the subagent provider that will start the teammate.
 * @param configured - the configured teammate defaults.
 * @param request - the call's own route fields.
 * @param signal - the tool call's cancellation.
 * @returns the teammate route, or undefined when it follows the provider and Lead unchanged.
 */
async function teammateRoute(
  ctx: Context,
  lead: Agent,
  providerName: string,
  configured: AgentOptions | undefined,
  request: DelegationModelRequest,
  signal: AbortSignal,
): Promise<TeammateRoute | undefined> {
  const explicit = hasDelegationModelRequest(request)
  const subagentProvider = ctx.subagents.getProvider(providerName)
  if ((explicit || configured !== undefined) && subagentProvider?.capabilities.agentOptions === false) {
    throw new Error(`subagent provider "${providerName}" cannot start a teammate on a chosen LLM route (no agentOptions capability)`)
  }
  if (!explicit && !hasConfiguredLlmSelection(configured)) return configured
  const allowed = subagentModelSelectionPolicy(ctx.sessionProjections, lead.session)
  if (explicit && allowed === undefined) {
    throw new Error('teammate model selection is not enabled for this Session; omit provider, model and reasoning_effort to use the configured teammate route')
  }
  const policy = allowed === undefined ? undefined : { routes: allowed }
  const parentOptions = parentAgentOptionsForDelegation(lead)
  const routeDefaults = subagentProvider?.agentRouteDefaults
  const baseline = routeDefaults === undefined ? configured : { ...routeDefaults, ...configured }
  let requested: AgentOptions | undefined
  try {
    requested = requestedAgentOptions(parentOptions, baseline, request, true)
    assertAllowedModelSelection(policy, parentOptions, requested, request)
    await preflightChildLlmRoute(ctx.llm, parentOptions, requested, signal, routeDefaults === undefined)
  } catch (error: unknown) {
    if (!explicit) throw error
    const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/u, '')
    throw new Error(`${message}.${ROUTE_HINT}`, { cause: error })
  }
  return requested
}

/** Model-facing collaboration guidance shared by Lead and teammates. */
const POLICY = `Agent Teams is available in this session, but create teammates only when the user explicitly asks to use Agent Teams or teammates.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`

const ACTIVE_WAIT_STATUSES: ReadonlySet<TeamMemberView['status']> = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.'

/**
 * One model-facing roster row. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    model: { type: 'string' },
    reasoningEffort: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** Expose the member name as its model-facing target. */
function modelMember(member: TeamMemberView): InferValue<typeof MEMBER_VIEW_SCHEMA> {
  const { id: _id, name, ...details } = member
  return { target: name, ...details }
}

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
  },
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
  },
} as const

/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, const: 'no-active-peer' },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: ResolvedConfig): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  try {
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: POLICY,
    }))

    register(scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
        description: { type: 'string', required: true, description: 'Short description of the delegated responsibility.' },
        prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
        provider: {
          type: 'string',
          description: 'LLM provider route for the teammate. Supply together with model after checking list_subagent_models; omit both to use the configured teammate route.',
        },
        model: {
          type: 'string',
          description: 'Model id interpreted by provider. Supply together with provider; omit both to use the configured teammate route.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Reasoning effort for the teammate route. Omit to use a compatible configured effort or the selected model\'s default.',
        },
      },
      output: jsonOutput(SPAWN_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'spawn_teammate')
        const context = args.context ?? 'fresh'
        const provider = context === 'fork' ? config.forkProvider : config.freshProvider
        const route = await teammateRoute(ctx, agent, provider, config.agentOptions, {
          ...args.provider === undefined ? {} : { provider: args.provider },
          ...args.model === undefined ? {} : { model: args.model },
          ...args.reasoning_effort === undefined ? {} : { reasoning_effort: args.reasoning_effort },
        }, exec.signal)
        const result = await ctx.agentTeams.spawnTeammate(agent, {
          name: args.name,
          description: args.description,
          prompt: [
            { type: 'text', text: `<system-reminder>
You are teammate "${args.name.trim()}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

` },
            { type: 'text', text: args.prompt },
          ],
          context,
          provider,
          ...route === undefined ? {} : { agentOptions: route },
          signal: exec.signal,
        })
        return { member: modelMember(result.member) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'send_message',
      description: 'Send one durable message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member target returned by spawn_teammate or list_agents, including lead.' },
        message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
      },
      output: jsonOutput(SEND_VALUE_SCHEMA),
      execute(args, exec) {
        return ctx.agentTeams.sendMessage(callingAgent(exec.agent, 'send_message'), {
          target: args.target,
          content: [{ type: 'text', text: args.message }],
          signal: exec.signal,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_agents',
      description: 'List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      execute(_args, exec) {
        return Promise.resolve(ctx.agentTeams.listMembers(callingAgent(exec.agent, 'list_agents')).map(modelMember))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'wait_agent',
      description: 'Wait for the next teammate status, mailbox, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.',
      parameters: {
        timeout_ms: {
          type: 'integer',
          description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
        },
      },
      output: jsonOutput(WAIT_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const timeoutMs = args.timeout_ms ?? 30_000
        // Preserve TeamService's authoritative timeout validation before the
        // model-only no-progress shortcut.
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
          return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        }
        // The active-peer read and waiter registration must remain one synchronous
        // span; awaiting between them can lose the only peer-status edge.
        const hasActivePeer = ctx.agentTeams.listMembers(caller).some(member =>
          member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))
        if (!hasActivePeer) {
          return {
            timedOut: false,
            noProgress: {
              reason: 'no-active-peer' as const,
              message: NO_ACTIVE_PEER_MESSAGE,
            },
          }
        }
        return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'interrupt_agent',
      description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
      parameters: {
        target: { type: 'string', required: true, description: 'Teammate target returned by spawn_teammate or list_agents.' },
      },
      output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
      execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, 'interrupt_agent'), args.target))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task on the shared Team task board.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'team_task_create'), {
          subject: args.subject,
          description: args.description,
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const status = args.status
        const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list')).filter(task =>
          (status === undefined || task.status === status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.getTask(
          callingAgent(exec.agent, 'team_task_get'),
          TeamTaskId(args.task_id),
        ))
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'],
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
        owner: { type: 'string', description: 'Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.updateTask(callingAgent(exec.agent, 'team_task_update'), {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...args.owner === undefined ? {} : { owner: args.owner },
        })
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install Team tools in every live or subsequently published Team member scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
    agentOptions: teammateDefaults(config.agentOptions),
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}
