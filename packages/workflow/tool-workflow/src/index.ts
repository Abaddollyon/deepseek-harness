/**
 * The model-facing `workflow` tool: run a JavaScript orchestration script that fans out
 * subagents, and return the script's final value. It owns the model-facing schema and run lifecycle; script
 * parsing, execution, caps, and cancellation live behind `ctx.workflowEngine`
 * (`@deepseek-ai/dsh-workflow`), so a hardened engine swaps in without touching what the model
 * sees. Caller ownership awaits `run.result`; supervisor ownership registers a non-resumable Job and
 * returns its handle immediately. Both lifecycles dispose before final settlement, and non-completed
 * caller reasons become tool errors. Presentation is an args-only generic card
 * titled from `meta.name`. Explicit-ask usage guidance is registered as the tool's own prompt
 * section rather than deployment persona prose.
 * @module @deepseek-ai/dsh-tool-workflow
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import type { RunDetachedData } from '@deepseek-ai/dsh-run-supervisor'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowResult, WorkflowRun, WorkflowStopReason } from '@deepseek-ai/dsh-workflow'
import type {
  ToolWorkflowAgentEndData, ToolWorkflowAgentStartData, ToolWorkflowLogData,
  ToolWorkflowPhaseData, ToolWorkflowRunEndData, ToolWorkflowRunStartData,
} from './types.ts'
// Declaration merges: ctx.jobs, the workflow job kind, and run/detached.
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-run-supervisor/types'
import type {} from '@deepseek-ai/dsh-spill'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    workflow: 'workflow'
  }
}

export const name = 'tool-workflow'
export const inject = ['tools', 'workflowEngine', 'systemPrompt']

/** Config: model-facing name, lifecycle ownership, and result/durable-progress caps. */
export interface Config {
  /** The model-facing tool name to register (default `workflow`). */
  toolName?: string
  /** Serialized-result ceiling; longer JSON spills and returns recovery metadata (default 50000). */
  maxResultChars?: number
  /** Durable phase/log event ceiling per run (default 2000). */
  maxProgressEvents?: number
  /** Durable workflow narration ceiling per line, in characters (default 2000). */
  maxLogChars?: number
  /** Run lifetime owner: the calling step or the background job supervisor (default `caller`). */
  ownership?: 'caller' | 'supervisor'
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow'),
  maxResultChars: z.natural().min(1).default(50_000),
  maxProgressEvents: z.natural().min(1).default(2000),
  maxLogChars: z.natural().min(1).default(2000),
  ownership: z.union(['caller', 'supervisor'] as const).default('caller'),
})

type ResolvedConfig = Required<Config>

interface WorkflowRecorder {
  start(session: Session, run: WorkflowRun, parentCallId: ToolWorkflowRunStartData['parentCallId']): void
  finish(runId: WorkflowRunId, stopReason: WorkflowStopReason): void
  abandon(runId: WorkflowRunId): void
}

interface ToolWorkflowRecordEventMap {
  'tool-workflow/run-start': ToolWorkflowRunStartData
  'tool-workflow/phase': ToolWorkflowPhaseData
  'tool-workflow/log': ToolWorkflowLogData
  'tool-workflow/agent-start': ToolWorkflowAgentStartData
  'tool-workflow/agent-end': ToolWorkflowAgentEndData
  'tool-workflow/run-end': ToolWorkflowRunEndData
}

/** Render a contained recording failure without trusting the thrown value. */
function renderRecordingError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/**
 * Project active workflow runs into their parent Sessions without
 * letting recording failure affect tool execution.
 */
function createWorkflowRecorder(ctx: Context, maxProgressEvents: number, maxLogChars: number): WorkflowRecorder {
  interface ActiveRecord {
    readonly session: Session
    progressEvents: number
  }
  const active = new Map<WorkflowRunId, ActiveRecord>()
  const append = <Type extends keyof ToolWorkflowRecordEventMap>(
    session: Session,
    type: Type,
    data: SessionEventMap[Type],
  ): boolean => {
    // These package-owned events are all log-only. Narrowing the generic
    // append face here discharges Session.append's conditional options tuple.
    const appendRecord = session.append.bind(session) as <Event extends keyof ToolWorkflowRecordEventMap>(
      event: Event,
      value: SessionEventMap[Event],
    ) => void
    try {
      appendRecord(type, data)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`tool-workflow: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`)
      return false
    }
  }

  const progress = (runId: WorkflowRunId, kind: 'phase' | 'log', value: string): void => {
    const record = active.get(runId)
    if (record === undefined || record.progressEvents >= maxProgressEvents) return
    record.progressEvents += 1
    const ordinal = record.progressEvents
    const budgetEnded = ordinal === maxProgressEvents
    if (kind === 'phase' && !budgetEnded) {
      const data: ToolWorkflowPhaseData = { runId, title: value, ordinal }
      if (!append(record.session, 'tool-workflow/phase', data)) active.delete(runId)
      return
    }
    const clipped = value.length > maxLogChars
    const message = clipped ? value.slice(0, maxLogChars) : value
    const data: ToolWorkflowLogData = {
      runId,
      message,
      ordinal,
      ...clipped || budgetEnded ? { truncated: true } : {},
    }
    if (!append(record.session, 'tool-workflow/log', data)) active.delete(runId)
  }

  ctx.on('workflow/phase', (info, title) => { progress(info.id, 'phase', title) })
  ctx.on('workflow/log', (info, message) => { progress(info.id, 'log', message) })
  ctx.on('workflow/agent-start', (info, agent) => {
    const record = active.get(info.id)
    if (record === undefined) return
    const data: ToolWorkflowAgentStartData = {
      runId: info.id,
      seq: agent.seq,
      label: agent.label,
      ...agent.phase === undefined ? {} : { phase: agent.phase },
      childId: agent.childId,
    }
    if (!append(record.session, 'tool-workflow/agent-start', data)) active.delete(info.id)
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    const record = active.get(info.id)
    if (record === undefined) return
    const data: ToolWorkflowAgentEndData = {
      runId: info.id,
      seq: agent.seq,
      outcome: agent.outcome,
    }
    if (!append(record.session, 'tool-workflow/agent-end', data)) active.delete(info.id)
  })

  return {
    start(session, run, parentCallId) {
      const data: ToolWorkflowRunStartData = {
        runId: run.id,
        name: run.meta.name,
        ...parentCallId === undefined ? {} : { parentCallId },
      }
      if (append(session, 'tool-workflow/run-start', data)) {
        active.set(run.id, { session, progressEvents: 0 })
      }
    },
    finish(runId, stopReason) {
      const record = active.get(runId)
      if (record !== undefined) append(record.session, 'tool-workflow/run-end', { runId, stopReason })
      active.delete(runId)
    },
    abandon: (runId) => { active.delete(runId) },
  }
}

/**
 * The script-authoring contract, embedded in the tool description. This IS the
 * model-facing spec: the meta block, the hooks and their exact semantics, and
 * the supported schema subset.
 */
const DESCRIPTION = `Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.

The workflow's identity rides the \`meta\` parameter as JSON: required \`name\` (short kebab-case) and \`description\` strings, optional \`whenToUse\` string and \`phases\` array (\`{title, detail?, provider?, model?, reasoningEffort?}\`). The \`script\` parameter is the plain JavaScript body ONLY (NOT TypeScript, and NO \`export const meta\` statement — meta is a parameter, not code), running with top-level await; end with \`return <value>\` — the value must be JSON-serializable and is this tool's result.

Script-body hooks:
- \`agent(prompt, opts?): Promise<any>\` — run one subagent to completion. Without \`opts.schema\` it resolves to the child's final text; with \`opts.schema\` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf — no pattern/format/numeric bounds) it resolves to the validated object. Resolves \`null\` when the child fails (filter with \`.filter(Boolean)\`). Other opts: \`label\` (display), \`phase\` (progress group), and the LLM target — \`provider\`, \`model\`, and \`reasoningEffort\` — which you may set to any registered provider, any model that provider serves, and any reasoning effort that model offers. Each of the three is independent: pass only the ones you want changed and the rest stay as this conversation's. A reasoning effort the selected model does not offer is refused before the child runs, never quietly lowered. Anything else (\`isolation\`/\`agentType\`) is rejected loudly.
- \`pipeline(items, ...stages): Promise<any[]>\` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives \`(prev, item, index)\`. An ordinary stage throw drops that ITEM to \`null\` and skips its remaining stages.
- \`parallel(thunks): Promise<any[]>\` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to \`null\`.
- \`phase(title)\` — start a progress phase; \`log(message)\` — narrate progress; \`args\` — the tool call's \`args\` input, verbatim.

Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) throw errors that ALWAYS kill the script — they never dissolve into a per-item \`null\`.

Constraints: concurrency and total-agent caps apply; no filesystem, network, timers, or Node.js APIs are provided — the agents do the work, the script only coordinates them. The cap applies to the serialized return value only. When it exceeds \`maxResultChars\`, the result is \`{ truncated: true, originalChars, spillPath, preview }\`; the explicit marker envelope may exceed \`maxResultChars\`, and the full value is readable at \`spillPath\`. The run executes in the foreground: this call returns when the whole script finishes.`

type WorkflowCallArgs = {
  script: string
  meta: {
    name: string
    description: string
    whenToUse?: string
    phases?: { title: string; detail?: string; provider?: string; model?: string; reasoningEffort?: string }[]
  }
  args?: Record<string, unknown>
}

/** The pending-state card: a generic card titled by the workflow's meta name. */
function presentWorkflowCall(args: WorkflowCallArgs): ToolCallView {
  return {
    card: 'generic',
    title: `workflow: ${args.meta.name}`,
    rawInput: args.script,
  }
}

/** The completed-state card: keep the pending title; render the result content as-is. */
function presentWorkflowResult(args: WorkflowCallArgs, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void args
  void result
  return { card: 'generic' }
}

/** A non-`completed` stop reason means the script did not finish cleanly. */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `workflow run was cancelled${result.error !== undefined ? ` (${result.error})` : ''}`
    case 'error':
      return `workflow run failed: ${result.error ?? 'unknown error'}`
  }
}

interface TruncatedWorkflowResult {
  [key: string]: JsonValue
  truncated: true
  originalChars: number
  spillPath: string
  preview: string
}

/** Persist an oversized serialized value and replace it with explicit recovery metadata. */
function projectResult(
  ctx: Context, session: Session, callId: SaveTextSpill['source']['callId'], name: string, value: JsonValue, maxChars: number,
): JsonValue | Promise<JsonValue> {
  // The engine returns JSON data (null for a valueless script), so stringify never yields undefined.
  const rendered = JSON.stringify(value, null, 2)
  if (rendered.length <= maxChars) return value
  const spillStore = ctx.get('spillStore')
  if (spillStore === undefined) {
    throw new Error('workflow result exceeds maxResultChars but no ctx.spillStore backend is mounted')
  }
  const save: SaveTextSpill = {
    owner: { sessionId: session.id },
    source: { toolName: 'workflow', callId, label: 'result' },
    suggestedName: `${name}-result.json`,
    content: rendered,
  }
  return spillStore.saveText(save).then((ref) => {
    const truncated: TruncatedWorkflowResult = {
      truncated: true, originalChars: rendered.length, spillPath: String(ref.locator), preview: rendered.slice(0, maxChars),
    }
    return truncated
  })
}

/** Render the run's outcome text: the meta name, agent count, and projected JSON value. */
function renderResult(name: string, agentsStarted: number, value: JsonValue): string {
  return `workflow "${name}" completed (${agentsStarted} agent${agentsStarted === 1 ? '' : 's'}).\nReturn value:\n${JSON.stringify(value, null, 2)}`
}

/** Await a supervisor-owned run through quiescence and map it to one final-output job. */
async function settleSupervisedRun(
  run: WorkflowRun,
  recorder: WorkflowRecorder,
  ctx: Context,
  session: Session,
  callId: SaveTextSpill['source']['callId'],
  maxResultChars: number,
): Promise<JobOutcome> {
  let result: WorkflowResult
  try {
    result = await run.result
    await run.dispose()
  } catch (error: unknown) {
    recorder.abandon(run.id)
    return { status: 'failed', detail: `workflow cleanup failed: ${String(error)}` }
  }
  recorder.finish(run.id, result.stopReason)
  recorder.abandon(run.id)
  switch (result.stopReason) {
    case 'completed':
      return {
        status: 'completed',
        output: renderResult(
          run.meta.name, result.agentsStarted,
          await projectResult(ctx, session, callId, run.meta.name, result.value as JsonValue, maxResultChars),
        ),
      }
    case 'cancelled':
      return { status: 'killed', ...result.error === undefined ? {} : { detail: result.error } }
    case 'error':
      return { status: 'failed', detail: result.error ?? 'unknown error' }
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (the exported Config schema) has already filled the defaulted
  // fields; the assertion records that resolution, not a hidden fallback.
  const { toolName, maxResultChars, maxProgressEvents, maxLogChars, ownership } = config as ResolvedConfig
  const jobs = ctx.get('jobs')
  if (ownership === 'supervisor') {
    if (ctx.workflowEngine.maxRunWallMs <= 0) {
      throw new Error("tool-workflow: ownership 'supervisor' requires workflowEngine.maxRunWallMs > 0")
    }
    if (jobs === undefined) {
      throw new Error("tool-workflow: ownership 'supervisor' requires @deepseek-ai/dsh-jobs in the same composition")
    }
  }
  const supervisedJobs = jobs as NonNullable<typeof jobs>
  const recorder = createWorkflowRecorder(ctx, maxProgressEvents, maxLogChars)
  // Usage policy ships with the tool (the master convention: tool guidance
  // lives in tool plugins as prompt sections, not in the deployment persona).
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
    text: `Use the ${toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.`,
  })
  ctx.tools.register(defineTool({
    name: toolName,
    description: ownership === 'caller'
      ? DESCRIPTION
      : DESCRIPTION.replace(
        'The run executes in the foreground: this call returns when the whole script finishes.',
        'The run executes as a supervised background job: this call returns immediately with `{ runId, jobId, status: \"running\" }`; use `job_output` to collect its final output or `job_kill` to cancel it.',
      ),
    parameters: {
      script: {
        type: 'string',
        required: true,
        description: 'The plain-JS workflow script body (top-level await allowed; NO `export const meta` statement; end with `return <json-value>`).',
      },
      meta: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'The workflow identity block (plain JSON — never code).',
        properties: {
          name: { type: 'string', required: true, description: 'Short kebab-case workflow name.' },
          description: { type: 'string', required: true, description: 'One-line description of what the workflow does.' },
          whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
          phases: {
            type: 'array',
            description: 'Optional phase declarations matched by phase() calls.',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                title: { type: 'string', required: true, description: 'The phase title phase() calls match by exact string.' },
                detail: { type: 'string', description: 'Optional one-line description of the phase.' },
                provider: { type: 'string', description: 'Optional provider override this phase is expected to use.' },
                model: { type: 'string', description: 'Optional model override this phase is expected to use.' },
                reasoningEffort: { type: 'string', description: 'Optional reasoning effort this phase is expected to use.' },
              },
            },
          },
        },
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).',
      },
    },
    output: ownership === 'caller' ? {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          agentsStarted: { type: 'integer', required: true },
          result: { type: 'json', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: renderResult(
          args.meta.name, value.agentsStarted as number, value.result as JsonValue,
        ),
      }],
    } : {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          jobId: { type: 'string', required: true },
          status: { type: 'string', enum: ['running'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify({ runId: value.runId, jobId: value.jobId, status: value.status }),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // The loop sets `exec.agent` for every model-driven call; its absence
        // means a non-agent caller invoked the tool directly, which has no
        // parent to attribute the children to. Fail loud rather than guess.
        throw new Error('workflow tool requires a calling agent (exec.agent was undefined)')
      }

      // Meta/body validation failures (META_INVALID/SCRIPT_PARSE) throw
      // synchronously here and become isError results via the registry — the
      // model sees the violation list and can correct the call.
      const startRun = (signal?: AbortSignal, id?: WorkflowRunId): WorkflowRun => {
        const run = ctx.workflowEngine.start({
          ...id !== undefined ? { id } : {},
          script: args.script,
          meta: args.meta,
          ...args.args !== undefined ? { args: args.args } : {},
          parent,
          ...signal !== undefined ? { signal } : {},
        })
        // The shipped worker-thread engine publishes progress/member events from later
        // worker messages, after start() returns and this run record is active.
        recorder.start(parent.session, run, exec.parent === undefined ? undefined : exec.rootCallId)
        return run
      }

      if (ownership === 'supervisor') {
        // The load-time assertion narrows the topology; caller ownership keeps Jobs optional.
        const label = `workflow: ${args.meta.name}`
        const durableRunId = WorkflowRunId(randomUUID())
        let run: WorkflowRun | undefined
        let jobId
        try {
          jobId = await supervisedJobs.startDurable({
            kind: 'workflow',
            label,
            owner: parent,
            durability: { recordSession: parent.session.id },
            idHint: String(durableRunId),
            run: () => {
              run = startRun(undefined, durableRunId)
              if (run.id !== durableRunId) {
                throw new Error(`workflow engine returned run id ${run.id} after accepting allocated id ${durableRunId}`)
              }
              return {
                cancel: (reason?: string) => { run?.cancel(reason ?? 'workflow job killed') },
                done: settleSupervisedRun(run, recorder, ctx, parent.session, exec.callId, maxResultChars),
              }
            },
          })
        } catch (error: unknown) {
          if (run !== undefined) {
            run.cancel('workflow job registration failed')
            void settleSupervisedRun(run, recorder, ctx, parent.session, exec.callId, maxResultChars)
          }
          throw error
        }
        if (run === undefined) throw new Error('durable workflow registration completed without starting its run')
        const detached: RunDetachedData = {
          jobId,
          kind: 'workflow',
          label,
          runId: run.id,
          resumable: false,
        }
        try {
          parent.session.append('run/detached', detached)
        } catch (error: unknown) {
          supervisedJobs.kill(jobId, parent, 'run/detached recording failed')
          throw error
        }
        return { runId: run.id, jobId, status: 'running' as const }
      }

      const run = startRun(exec.signal)

      // Caller ownership keeps the foreground abort bridge byte-identical.
      const onAbort = (): void => { run.cancel('parent step aborted') }
      exec.signal.addEventListener('abort', onAbort, { once: true })

      let result: WorkflowResult | undefined
      try {
        result = await run.result
        const error = stopReasonError(result)
        if (error !== undefined) {
          // Map a non-clean finish to an isError result (the registry turns a
          // throw into an isError). Report the reason, not partial output.
          throw new Error(error)
        }
        const projected = projectResult(ctx, parent.session, exec.callId, run.meta.name, result.value as JsonValue, maxResultChars)
        return {
          runId: run.id,
          agentsStarted: result.agentsStarted,
          result: projected instanceof Promise ? await projected : projected,
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
        try {
          // Keep member listeners alive through disposal: an engine may
          // synthesize cancelled member endings while reaching quiescence.
          await run.dispose()
          if (result === undefined) throw new Error('workflow run settled without a result')
          recorder.finish(run.id, result.stopReason)
        } finally {
          recorder.abandon(run.id)
        }
      }
    },
    presentCall: args => presentWorkflowCall(args),
    presentResult: (args, result) => presentWorkflowResult(args, result),
  }))
}
