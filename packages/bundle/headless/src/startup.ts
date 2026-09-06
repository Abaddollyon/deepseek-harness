/**
 * The one-shot app's command-line provider: it parses the task positional and
 * `--help`, then publishes {@link HEADLESS_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command, InvalidArgumentError } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { AgentBudget, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the one-shot runner. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}. */
export interface HeadlessStartupValues {
  /** The task text this invocation asked for. */
  task: string
  /** Optional complete native model-execution budget. */
  budget?: AgentBudget | undefined
  /** Optional complete per-run selection that bypasses saved defaults. */
  selection?: ModelSelection | undefined
}

interface BudgetOptions {
  maxTurns?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxRetries?: number
  provider?: string
  model?: string
  reasoningEffort?: string
}

function integer(value: string, allowZero = false): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new InvalidArgumentError(allowZero ? 'must be a nonnegative safe integer' : 'must be a positive safe integer')
  }
  return parsed
}

function budgetFrom(options: BudgetOptions, program: Command): AgentBudget | undefined {
  const { maxTurns, maxInputTokens, maxOutputTokens, maxRetries } = options
  const values = [maxTurns, maxInputTokens, maxOutputTokens, maxRetries]
  if (values.every(value => value === undefined)) return undefined
  if (maxTurns === undefined || maxInputTokens === undefined || maxOutputTokens === undefined || maxRetries === undefined) {
    program.error('error: all four budget options must be provided together')
    throw new Error('unreachable after Commander exits')
  }
  return { maxTurns, maxInputTokens, maxOutputTokens, maxRetries }
}

function selectionFrom(options: BudgetOptions, program: Command): ModelSelection | undefined {
  if (options.provider === undefined && options.model === undefined && options.reasoningEffort === undefined) return undefined
  if (options.provider === undefined || options.model === undefined) {
    program.error('error: --provider and --model must be provided together, and are required with --reasoning-effort')
  }
  return {
    provider: options.provider,
    model: options.model,
    ...options.reasoningEffort === undefined || options.reasoningEffort === 'provider-default'
      ? {}
      : { reasoningEffort: ReasoningEffortId(options.reasoningEffort) },
  }
}

/**
 * This app's command: the task positional, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task, stream reasoning to stderr, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .option('--provider <id>', 'per-run provider route')
    .option('--model <id>', 'per-run provider-owned model id')
    .option('--reasoning-effort <id>', 'explicit effort or provider-default')
    .option('--max-turns <count>', 'maximum model steps', value => integer(value))
    .option('--max-input-tokens <count>', 'response-accounted input-token threshold', value => integer(value))
    .option('--max-output-tokens <count>', 'total requested output-token cap', value => integer(value))
    .option('--max-retries <count>', 'maximum additional model attempts', value => integer(value, true))
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"     answer one task and exit
`)
}

/**
 * Parse and provide the one-shot task as an ordinary Cordis service. The
 * command's action publishes the task; a missing or whitespace-only task is a
 * usage error, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  program.action(() => {
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    const budget = budgetFrom(program.opts<BudgetOptions>(), program)
    const selection = selectionFrom(program.opts<BudgetOptions>(), program)
    ctx.provide(HEADLESS_STARTUP_SERVICE, {
      task,
      ...budget === undefined ? {} : { budget },
      ...selection === undefined ? {} : { selection },
    } satisfies HeadlessStartupValues)
  })
  parseCmdline(ctx, program)
}
