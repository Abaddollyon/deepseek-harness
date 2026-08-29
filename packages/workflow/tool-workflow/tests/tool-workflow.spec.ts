import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkflowRunId, WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowResult, WorkflowRun,
  WorkflowRunId as WorkflowRunIdType, WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import * as toolWorkflow from '../src/index.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const testToolSignal = new AbortController().signal

/** A controllable engine standing in behind ctx.workflowEngine (the tool's only seam). */
class StubEngine extends WorkflowEngine {
  readonly maxRunWallMs: number = 1000
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  disposed = 0
  disposeBarrier: Promise<void> | undefined
  settle!: (result: WorkflowResult) => void
  readonly settlements = new Map<WorkflowRunIdType, (result: WorkflowResult) => void>()
  startError: Error | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError) throw this.startError
    this.requests.push(request)
    const id = WorkflowRunId(`run-${this.requests.length}`)
    const result = new Promise<WorkflowResult>((resolve) => { this.settle = resolve })
    this.settlements.set(id, this.settle)
    request.signal?.addEventListener('abort', () => {
      this.settle({ value: null, stopReason: 'cancelled', error: 'signal', agentsStarted: 0 })
    }, { once: true })
    return {
      id,
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle({ value: null, stopReason: 'cancelled', ...reason !== undefined ? { error: reason } : {}, agentsStarted: 0 })
      },
      dispose: async () => {
        this.disposed += 1
        await this.disposeBarrier
        this.settlements.delete(id)
      },
    }
  }

  settleRun(id: WorkflowRunIdType, result: WorkflowResult): void {
    const settle = this.settlements.get(id)
    if (settle === undefined) throw new Error(`unknown stub workflow ${id}`)
    settle(result)
  }

  phase(id: WorkflowRunIdType, title: string): void {
    this.emitWorkflowEvent('workflow/phase', {
      id, meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, title)
  }

  log(id: WorkflowRunIdType, message: string): void {
    this.emitWorkflowEvent('workflow/log', {
      id, meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, message)
  }

  agentStart(id: WorkflowRunIdType, agent: WorkflowAgentInfo): void {
    this.emitWorkflowEvent('workflow/agent-start', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, agent)
  }

  agentEnd(id: WorkflowRunIdType, agent: WorkflowAgentEndInfo): void {
    this.emitWorkflowEvent('workflow/agent-end', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, agent)
  }
}

class UnboundedStubEngine extends StubEngine {
  override readonly maxRunWallMs = 0
}

async function setup(config?: toolWorkflow.Config) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubEngine)
  if (config?.ownership === 'supervisor') {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, {})
    ctx.jobs.attachController('workflow-test')
  }
  await ctx.plugin(toolWorkflow, config ?? {})
  const engine = ctx.workflowEngine as StubEngine
  const session = Session.create(SessionId('caller'))
  const parent = {
    id: session.id, options: {}, session,
    ...config?.ownership === 'supervisor' ? { ctx, status: 'idle' as const } : {},
  } as unknown as Agent
  if (config?.ownership === 'supervisor') ctx.agents.register(parent)
  return { ctx, engine, parent, session }
}

const SCRIPT = 'return 1'
const META = { name: 'audit', description: 'd' }

function execute(ctx: Context, args: unknown, extra?: {
  agent?: Agent
  signal?: AbortSignal
  parent?: ToolExecutionToken
  rootCallId?: ToolCallId
}): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId('call-1'),
    name: 'workflow',
    arguments: args,
    ...extra?.agent ? { agent: extra.agent } : {},
    ...extra?.signal ? { signal: extra.signal } : {},
    ...extra?.parent ? { parent: extra.parent } : {},
    ...extra?.rootCallId ? { rootCallId: extra.rootCallId } : {},
  })
}

describe('dsh-tool-workflow', () => {
  it('fails at plugin load when supervisor ownership has no Jobs service', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubEngine)
    await expect(ctx.plugin(toolWorkflow, { ownership: 'supervisor' })).rejects.toThrow(
      "ownership 'supervisor' requires @deepseek-ai/dsh-jobs",
    )
  })

  it('fails at plugin load when supervisor ownership has an unbounded workflow engine', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UnboundedStubEngine)
    await ctx.plugin(LocalJobRegistry, {})
    ctx.jobs.attachController('workflow-test')
    await expect(ctx.plugin(toolWorkflow, { ownership: 'supervisor' })).rejects.toThrow(
      "ownership 'supervisor' requires workflowEngine.maxRunWallMs > 0",
    )
  })

  it('rewrites the supervised description at its exact foreground anchor', async () => {
    const { ctx } = await setup({ ownership: 'supervisor' })
    const description = ctx.tools.get('workflow')?.description
    expect(description).toContain('supervised background job')
    expect(description).not.toContain('returns when the whole script finishes')
  })

  it('starts a run with the script/args/parent/signal and renders the completed value', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { script: SCRIPT, meta: META, args: { files: ['a.ts'] } }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    expect(engine.requests[0]).toMatchObject({ script: SCRIPT, meta: META, args: { files: ['a.ts'] }, parent })
    expect(engine.requests[0]!.signal).toBe(controller.signal)
    engine.settle({ value: { findings: [1, 2] }, stopReason: 'completed', agentsStarted: 7 })
    const result = await pending
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected workflow success')
    expect(result.value).toEqual({ runId: 'run-1', agentsStarted: 7, result: { findings: [1, 2] } })
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('workflow "audit" completed (7 agents)')
    expect(rendered).toContain('"findings"')
    expect(engine.disposed).toBe(1)
  })

  it('returns a non-resumable supervised job immediately without binding the caller signal', async () => {
    const { ctx, engine, parent, session } = await setup({ ownership: 'supervisor' })
    const controller = new AbortController()
    const result = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent, signal: controller.signal })
    if (result.isError) throw new Error((result.content[0] as { text: string }).text)
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ runId: 'run-1', jobId: 'workflow-run-1', status: 'running' })
    expect(engine.requests[0]!.signal).toBeUndefined()
    expect(ctx.jobs.get(JobId('workflow-run-1'), parent)).toMatchObject({
      kind: 'workflow', label: 'workflow: audit', status: 'running', resumable: false,
    })
    expect(session.events.map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId: 'run-1', name: 'audit' }],
      ['run/detached', {
        jobId: 'workflow-run-1', kind: 'workflow', label: 'workflow: audit', runId: 'run-1', resumable: false,
      }],
    ])
    controller.abort('step settled')
    expect(engine.cancels).toEqual([])
    engine.settleRun(WorkflowRunId('run-1'), { value: { answer: 42 }, stopReason: 'completed', agentsStarted: 2 })
    const settled = await ctx.jobs.wait(JobId('workflow-run-1'), 1000, parent)
    expect(settled.status).toBe('completed')
    expect(engine.disposed).toBe(1)
    expect(ctx.jobs.read(JobId('workflow-run-1'), parent).text).toContain('\"answer\": 42')
    expect(session.events.at(-1)).toMatchObject({
      type: 'tool-workflow/run-end', data: { runId: 'run-1', stopReason: 'completed' },
    })
  })

  it('routes a workflow job kill through run.cancel and closes after disposal', async () => {
    const { ctx, engine, parent, session } = await setup({ ownership: 'supervisor' })
    const started = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    if (started.isError) throw new Error((started.content[0] as { text: string }).text)
    expect(started.isError).toBe(false)
    expect(ctx.jobs.kill(JobId('workflow-run-1'), parent, 'user stopped workflow')).toBe('requested')
    expect(engine.cancels).toEqual(['user stopped workflow'])
    expect(ctx.jobs.get(JobId('workflow-run-1'), parent).status).toBe('stopping')
    const settled = await ctx.jobs.wait(JobId('workflow-run-1'), 1000, parent)
    expect(settled).toMatchObject({ status: 'killed', detail: 'user stopped workflow', reported: true })
    expect(engine.disposed).toBe(1)
    expect(session.events.at(-1)).toMatchObject({
      type: 'tool-workflow/run-end', data: { runId: 'run-1', stopReason: 'cancelled' },
    })
  })

  it('maps supervised error, cancellation-without-detail, and cleanup failure outcomes', async () => {
    {
      const { ctx, engine, parent } = await setup({ ownership: 'supervisor' })
      await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
      engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'error', agentsStarted: 0 })
      expect(await ctx.jobs.wait(JobId('workflow-run-1'), 1000, parent)).toMatchObject({
        status: 'failed', detail: 'unknown error',
      })
    }
    {
      const { ctx, engine, parent } = await setup({ ownership: 'supervisor' })
      await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
      engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'cancelled', agentsStarted: 0 })
      const settled = await ctx.jobs.wait(JobId('workflow-run-1'), 1000, parent)
      expect(settled.status).toBe('killed')
      expect(settled.detail).toBeUndefined()
    }
    {
      const { ctx, engine, parent } = await setup({ ownership: 'supervisor' })
      await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
      ctx.jobs.kill(JobId('workflow-run-1'), parent)
      expect(engine.cancels).toEqual(['workflow job killed'])
      await ctx.jobs.wait(JobId('workflow-run-1'), 1000, parent)
    }
    {
      const { ctx, engine, parent } = await setup({ ownership: 'supervisor' })
      engine.disposeBarrier = Promise.reject(new Error('dispose broke'))
      await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
      engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
      expect(await ctx.jobs.wait(JobId('workflow-run-1'), 1000, parent)).toMatchObject({
        status: 'failed', detail: 'workflow cleanup failed: Error: dispose broke',
      })
    }
  })

  it('cancels and settles the run when job registration fails', async () => {
    const { ctx, engine, parent } = await setup({ ownership: 'supervisor' })
    vi.spyOn(ctx.jobs, 'start').mockImplementation(() => { throw new Error('registry down') })
    const result = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('registry down')
    expect(engine.cancels).toEqual(['workflow job registration failed'])
    await vi.waitFor(() => { expect(engine.disposed).toBe(1) })
  })

  it('kills the registered job when run/detached cannot be recorded', async () => {
    const { ctx, engine, parent, session } = await setup({ ownership: 'supervisor' })
    const append = session.append.bind(session)
    vi.spyOn(session, 'append').mockImplementation(((type: string, data: unknown) => {
      if (type === 'run/detached') throw new Error('session read-only')
      return (append as (type: string, data: unknown) => unknown)(type, data)
    }) as typeof session.append)
    const result = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('session read-only')
    expect(engine.cancels).toEqual(['run/detached recording failed'])
    await vi.waitFor(() => { expect(engine.disposed).toBe(1) })
  })

  it('records one top-level run and its members in the calling Session after cleanup', async () => {
    const { ctx, engine, parent, session } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const runId = WorkflowRunId('run-1')
    engine.agentStart(runId, {
      seq: 1,
      label: '',
      phase: '',
      childId: SessionId('child-1'),
    })
    engine.agentEnd(runId, {
      seq: 1,
      label: '',
      phase: '',
      childId: SessionId('child-1'),
      outcome: 'completed',
    })
    engine.settleRun(runId, { value: 1, stopReason: 'completed', agentsStarted: 1 })
    expect((await pending).isError).toBe(false)
    expect(engine.disposed).toBe(1)
    expect(session.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId: 'run-1', name: 'audit' }],
      ['tool-workflow/agent-start', {
        runId: 'run-1', seq: 1, label: '', phase: '', childId: 'child-1',
      }],
      ['tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'completed' }],
      ['tool-workflow/run-end', { runId: 'run-1', stopReason: 'completed' }],
    ])
  })

  it('writes run-end only after run disposal reaches quiescence', async () => {
    const { ctx, engine, parent, session } = await setup()
    const barrier = Promise.withResolvers<undefined>()
    engine.disposeBarrier = barrier.promise
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settleRun(WorkflowRunId('run-1'), {
      value: null, stopReason: 'completed', agentsStarted: 0,
    })
    await vi.waitFor(() => { expect(engine.disposed).toBe(1) })
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['tool-workflow/run-start'])
    barrier.resolve(undefined)
    expect((await pending).isError).toBe(false)
    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/run-end',
    ])
  })

  it('records zero-member and concurrent runs independently', async () => {
    const { ctx, engine, parent, session } = await setup()
    const first = execute(ctx, { script: SCRIPT, meta: { ...META, name: 'first' } }, { agent: parent })
    const second = execute(ctx, { script: SCRIPT, meta: { ...META, name: 'second' } }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(2) })
    const secondId = WorkflowRunId('run-2')
    engine.agentStart(secondId, {
      seq: 1, label: 'member', childId: SessionId('child-2'),
    })
    engine.agentEnd(secondId, {
      seq: 1, label: 'member', childId: SessionId('child-2'), outcome: 'failed',
    })
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
    engine.settleRun(secondId, { value: null, stopReason: 'error', error: 'child failed', agentsStarted: 1 })
    expect((await first).isError).toBe(false)
    expect((await second).isError).toBe(true)
    expect(session.snapshotEvents().filter(event => event.type === 'tool-workflow/agent-start'))
      .toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-end').map(event => event.data))
      .toEqual([
        { runId: 'run-1', stopReason: 'completed' },
        { runId: 'run-2', stopReason: 'error' },
      ])
  })

  it('records nested transport executions with their enclosing model call', async () => {
    const { ctx, engine, parent, session } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, {
      agent: parent,
      parent: Symbol('outer') as ToolExecutionToken,
      rootCallId: ToolCallId('outer-call'),
    })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
    expect((await pending).isError).toBe(false)
    expect(session.events.map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId: 'run-1', name: 'audit', parentCallId: 'outer-call' }],
      ['tool-workflow/run-end', { runId: 'run-1', stopReason: 'completed' }],
    ])
  })

  it('records bounded, clipped workflow progress with monotone ordinals', async () => {
    const { ctx, engine, parent, session } = await setup({ maxProgressEvents: 3, maxLogChars: 4 })
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const runId = WorkflowRunId('run-1')
    engine.phase(runId, 'Scan')
    engine.log(runId, 'abcdef')
    engine.log(runId, 'last')
    engine.phase(runId, 'dropped')
    engine.log(runId, 'dropped')
    engine.settleRun(runId, { value: null, stopReason: 'completed', agentsStarted: 0 })
    expect((await pending).isError).toBe(false)
    expect(session.events.slice(1, -1).map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/phase', { runId: 'run-1', title: 'Scan', ordinal: 1 }],
      ['tool-workflow/log', { runId: 'run-1', message: 'abcd', ordinal: 2, truncated: true }],
      ['tool-workflow/log', { runId: 'run-1', message: 'last', ordinal: 3, truncated: true }],
    ])
  })

  it.each([
    'tool-workflow/run-start',
    'tool-workflow/phase',
    'tool-workflow/log',
    'tool-workflow/agent-start',
    'tool-workflow/agent-end',
    'tool-workflow/run-end',
  ] as const)('isolates a first append failure at %s and preserves a valid prefix', async (failedType) => {
    const { ctx, engine, parent, session } = await setup()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const append = session.append.bind(session)
    session.append = ((type: Parameters<Session['append']>[0], data: never) => {
      if (type === failedType) throw new Error(`injected ${failedType} failure`)
      return append(type, data)
    }) as Session['append']

    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const runId = WorkflowRunId('run-1')
    engine.phase(runId, 'phase')
    engine.log(runId, 'log')
    engine.agentStart(runId, {
      seq: 1, label: 'member', childId: SessionId('child-1'),
    })
    engine.agentEnd(runId, {
      seq: 1, label: 'member', childId: SessionId('child-1'), outcome: 'completed',
    })
    engine.settleRun(runId, { value: null, stopReason: 'completed', agentsStarted: 1 })
    expect((await pending).isError).toBe(false)
    expect(engine.disposed).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(failedType)
    const types = session.snapshotEvents().map(event => event.type)
    const expectedPrefixes = {
      'tool-workflow/run-start': [],
      'tool-workflow/phase': ['tool-workflow/run-start'],
      'tool-workflow/log': ['tool-workflow/run-start', 'tool-workflow/phase'],
      'tool-workflow/agent-start': ['tool-workflow/run-start', 'tool-workflow/phase', 'tool-workflow/log'],
      'tool-workflow/agent-end': [
        'tool-workflow/run-start', 'tool-workflow/phase', 'tool-workflow/log', 'tool-workflow/agent-start',
      ],
      'tool-workflow/run-end': [
        'tool-workflow/run-start', 'tool-workflow/phase', 'tool-workflow/log',
        'tool-workflow/agent-start', 'tool-workflow/agent-end',
      ],
    } as const
    expect(types).toEqual(expectedPrefixes[failedType])
  })

  it('contains an append failure whose thrown value cannot be rendered', async () => {
    const { ctx, engine, parent, session } = await setup()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    session.append = () => {
      throw { toString: () => { throw new Error('coercion trap') } }
    }
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settleRun(WorkflowRunId('run-1'), {
      value: null, stopReason: 'completed', agentsStarted: 0,
    })
    expect((await pending).isError).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[unrenderable thrown value]')
  })

  it('maps a non-completed stop reason to an isError result (and still disposes)', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'error', error: 'script threw: boom', agentsStarted: 2 })
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('workflow run failed: script threw: boom')
    expect(engine.disposed).toBe(1)
  })

  it('reports a cancelled run distinctly (with and without a reason)', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'cancelled', error: 'user', agentsStarted: 0 })
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('workflow run was cancelled (user)')

    const bare = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(2) })
    engine.settle({ value: null, stopReason: 'cancelled', agentsStarted: 0 })
    expect(((await bare).content[0] as { text: string }).text.trim().endsWith('cancelled')).toBe(true)
  })

  it('an error result without a message renders the unknown-error fallback', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'error', agentsStarted: 0 })
    expect(((await pending).content[0] as { text: string }).text).toContain('unknown error')
  })

  it('cancels the run when exec.signal aborts MID-FLIGHT (the abort bridge)', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(engine.cancels).toContain('parent step aborted')
    expect(engine.disposed).toBe(1)
  })

  it('a synchronous engine start throw (meta/parse failure) becomes an isError result', async () => {
    const { ctx, engine, parent } = await setup()
    engine.startError = new Error('invalid meta: meta.name must be a non-empty string')
    const result = await execute(ctx, { script: 'nope', meta: { name: '', description: 'd' } }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('meta.name must be a non-empty string')
  })

  it('requires a calling agent (fails loud without exec.agent)', async () => {
    const { ctx, engine } = await setup()
    const result = await execute(ctx, { script: SCRIPT, meta: META })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('requires a calling agent')
    expect(engine.requests.length).toBe(0)
  })

  it('validates its own arguments via the schema DSL (missing script)', async () => {
    const { ctx, parent } = await setup()
    const result = await execute(ctx, {}, { agent: parent })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  })

  it('skips workflow startup when exec.signal is already aborted', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })
    expect(engine.requests).toHaveLength(0)
    expect(engine.cancels).toHaveLength(0)
    expect(engine.disposed).toBe(0)
  })

  it('truncates an oversized rendered value with a notice (maxResultChars)', async () => {
    const { ctx, engine, parent } = await setup({ maxResultChars: 40 })
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: { blob: 'x'.repeat(500) }, stopReason: 'completed', agentsStarted: 1 })
    const result = await pending
    if (result.isError) throw new Error('expected workflow success')
    expect(result.value).toEqual({ runId: 'run-1', agentsStarted: 1, result: { blob: 'x'.repeat(500) } })
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('[truncated:')
    expect(rendered.length).toBeLessThan(400)
  })

  it('registers under a configured toolName and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubEngine)
    const fiber = await ctx.plugin(toolWorkflow, { toolName: 'orchestrate' })
    expect(ctx.tools.get('orchestrate')).toBeDefined()
    expect(ctx.tools.get('workflow')).toBeUndefined()
    // The usage-policy prompt section rides the same registration: present
    // under the CONFIGURED name (its guidance names the tool it describes)…
    const sections = (await ctx.systemPrompt.assemble()).sections
    const section = sections.find(s => s.name === 'tool:orchestrate')
    expect(section?.text).toContain('orchestrate')
    expect(sections.some(s => s.name === 'tool:workflow')).toBe(false)
    ctx.systemPrompt.section({ name: 'tool:cordis-order-probe', order: 115.5, text: 'Cordis' })
    expect((await ctx.systemPrompt.assemble()).sections
      .filter(s => s.name === 'tool:cordis-order-probe' || s.name === 'tool:orchestrate')
      .map(s => s.name)).toEqual(['tool:cordis-order-probe', 'tool:orchestrate'])
    await fiber.dispose()
    expect(ctx.tools.get('orchestrate')).toBeUndefined()
    // …and gone with the fiber — a reload must not leak a stale section.
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'tool:orchestrate')).toBe(false)
  })

  it('presents a generic pending card titled by the meta name, with the script as rawInput', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('workflow')!
    const view = tool.presentCall!({ script: SCRIPT, meta: META })
    expect(view).toMatchObject({ card: 'generic', title: 'workflow: audit', rawInput: SCRIPT })
  })

  it('presentResult keeps the generic card; presentation is pure and replay-safe on malformed args', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('workflow')!
    expect(tool.presentResult!({ script: SCRIPT, meta: META }, { content: [], isError: false })).toEqual({ card: 'generic' })
    // defineTool soft-validates presentation args: a malformed logged shape
    // (wrong fields entirely, or a call missing its meta) falls back to
    // undefined instead of throwing mid-replay.
    expect(tool.presentCall!({ not: 'the schema' })).toBeUndefined()
    expect(tool.presentCall!({ script: SCRIPT })).toBeUndefined()
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in toolWorkflow).toBe(false)
    expect(toolWorkflow.name).toBe('tool-workflow')
    expect(toolWorkflow.inject).toEqual(['tools', 'workflowEngine', 'systemPrompt'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolWorkflow) as Record<string, unknown>
    expect(unwrapped).toBe(toolWorkflow)
    expect(typeof unwrapped.apply).toBe('function')
  })

  describe('composition with the REAL worker-thread engine (the mock above must stay honest)', () => {
    it('an abort releases the tool even when the script parks on a promise no hook owns', async () => {
      // The tool and loop await run.result before cleanup, so cancellation must settle a script
      // parked on an unowned promise. Exercise that guarantee through the real registry and worker.
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      ctx.subagents.registerProvider({
        name: 'spawn',
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        inheritsParentContext: false,
        start: () => Promise.reject(new Error('the parked-script fixture must not start a child')),
      })
      await ctx.plugin(WorkerThreadWorkflowEngine, { disposeGraceMs: 30 })
      await ctx.plugin(toolWorkflow, {})
      const session = Session.create(SessionId('caller'))
      const parent = { id: session.id, options: {}, session, ctx } as unknown as Agent
      const controller = new AbortController()
      const pending = execute(ctx, {
        script: 'await new Promise(() => {})\nreturn 1',
        meta: { name: 'stuck', description: 'parks forever' },
      }, { agent: parent, signal: controller.signal })
      // Give the run a beat to start (past its synchronous slice), then abort.
      await new Promise(resolve => setTimeout(resolve, 20))
      controller.abort('user abort')
      const result = await pending
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('cancelled')
    })
  })
})
