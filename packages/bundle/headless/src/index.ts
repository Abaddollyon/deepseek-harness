/**
 * @deepseek-ai/dsh-headless — one-shot direct Agent driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry, drives the task to quiescence,
 * streams provider reasoning to stderr, flushes its Session, prints the final
 * assistant text to stdout, and exits.
 *
 * @module @deepseek-ai/dsh-headless
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentBudget, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'headless-runner'

/** Core services required before the one-shot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the task resolved from this app's injected provider service. */
export interface Config {
  /** The prompt text for the single run. */
  task: string
  /** Optional complete native model-execution budget. */
  budget?: AgentBudget
  /** Optional complete per-run model selection. */
  selection?: ModelSelection
}

const BUDGET_KEYS = ['maxTurns', 'maxInputTokens', 'maxOutputTokens', 'maxRetries'] as const
const AGENT_BUDGET_SCHEMA: z<AgentBudget> = z.object({
  maxTurns: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxInputTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxOutputTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).required(),
})
const MODEL_SELECTION_SCHEMA: z<ModelSelection> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
}) as z<ModelSelection>

function validateBudget(value: unknown): AgentBudget | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('headless budget must be an object')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) throw new TypeError(`headless budget has unknown key "${key}"`)
  }
  for (const key of BUDGET_KEYS) {
    const candidate = record[key]
    const valid = Number.isSafeInteger(candidate) && (key === 'maxRetries' ? Number(candidate) >= 0 : Number(candidate) > 0)
    if (!valid) throw new TypeError(`headless budget.${key} must be ${key === 'maxRetries' ? 'a nonnegative' : 'a positive'} safe integer`)
  }
  return structuredClone(value) as AgentBudget
}

export const Config: z<Config> = z.object({
  task: z.string().required(),
  budget: z.union([AGENT_BUDGET_SCHEMA, z.never()]),
  selection: z.union([MODEL_SELECTION_SCHEMA, z.never()]),
})

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: HeadlessIo['stdout']; stderr: HeadlessIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(session: Session, firstSeq: SessionLogOffset): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`headless summary cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/**
 * Project provider-reported reasoning from one owned run to stderr as it is
 * appended, while keeping final outcome derivation on the durable log.
 * @param ctx - plugin context carrying the Session event feed.
 * @param agent - the exact Agent whose reasoning belongs to this invocation.
 * @param stderr - progress output sink.
 * @returns a disposer that also terminates an unterminated reasoning line.
 */
function streamReasoning(
  ctx: Context,
  agent: Agent,
  stderr: HeadlessIo['stderr'],
): () => void {
  let started = false
  let open = false
  let endsWithNewline = true
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) stderr.write('\n')
    open = false
    endsWithNewline = true
  }
  const dispose = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/start') {
      close()
      started = true
      return
    }
    if (!started || event.type !== 'assistant/chunk') return
    const chunk = event.data.chunk
    switch (chunk.type) {
      case 'reasoning-delta':
        if (chunk.text === '') return
        if (!open) {
          stderr.write('dsh: reasoning:\n')
          open = true
        }
        stderr.write(chunk.text)
        endsWithNewline = chunk.text.endsWith('\n')
        return
      case 'block-start':
        if (chunk.blockType !== 'reasoning') close()
        return
      case 'block-end':
        if (chunk.block.type !== 'reasoning') close()
        return
      case 'usage':
        return
      case 'text-delta':
      case 'tool-call-delta':
      case 'finish':
        close()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(chunk, 'headless reasoning stream')
    }
  })
  return () => {
    dispose()
    close()
  }
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: HeadlessIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Run one task through a freshly created Agent and request process exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param task - one-shot task text.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: HeadlessIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = config.selection ?? defaultModel.currentSelection()
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer. A deployment
  // that DOES configure one has to join it here first
  // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
  const { agent } = await agents.create({
    sessionId: brandString<SessionId>(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      ...config.budget === undefined ? {} : { budget: config.budget },
    },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  const stopReasoning = streamReasoning(ctx, agent, io.stderr)
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: config.task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
  } finally {
    stopReasoning()
  }
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session, firstSeq)
  io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/**
 * Mount the one-shot direct driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated task config.
 */
export function apply(ctx: Context, config: Config): void {
  const budget = validateBudget(config.budget)
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: HeadlessIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, {
    task: config.task,
    ...budget === undefined ? {} : { budget },
    ...config.selection === undefined ? {} : { selection: structuredClone(config.selection) },
  }, io)
    .catch((error: unknown) => { fail(io, error) })
}
