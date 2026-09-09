/**
 * The one-shot app's ordinary command-line provider over a real Loader tree:
 * the task becomes injected runner config, while help and usage errors leave
 * the consumer pending.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, HEADLESS_STARTUP_SERVICE, type HeadlessStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  runnerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

/** Fixture tree roots, removed after their booted tree has been disposed. */
const tempDirs: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider over a runner stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the resolved service value and observed runner/process effects.
 */
async function bootStartup(args: string[]): Promise<{ task: HeadlessStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-startup-'))
  tempDirs.push(dir)
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__headlessStartupObserved.runnerConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'headless-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__headlessStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: headless-runner',
    `  name: ${rowUrl}`,
    `  inject: [${HEADLESS_STARTUP_SERVICE}]`,
    '  config:',
    '    task: !!js ctx.headlessStartup.task',
    '    budget: !!js ctx.headlessStartup.budget',
    '    selection: !!js ctx.headlessStartup.selection',
    '- id: headless-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __headlessStartupApply: typeof apply
    __headlessStartupObserved: Observed
  }
  globals.__headlessStartupApply = apply
  globals.__headlessStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    task: ctx.get(HEADLESS_STARTUP_SERVICE) as HeadlessStartupValues | undefined,
    observed,
  }
}

describe('headless command-line provider', () => {
  it('joins the task positional into the runner config', async () => {
    const { task, observed } = await bootStartup(['run', 'the', 'tests'])
    expect(task).toEqual({ task: 'run the tests' })
    expect(observed.runnerConfig).toEqual({ task: 'run the tests' })
    expect(observed.exits).toEqual([])
  })

  it('projects a complete native budget from command-line flags', async () => {
    const { task, observed } = await bootStartup([
      '--max-turns', '4',
      '--max-input-tokens', '1200',
      '--max-output-tokens', '300',
      '--max-retries', '0',
      'run', 'the', 'tests',
    ])
    const expected = {
      task: 'run the tests',
      budget: { maxTurns: 4, maxInputTokens: 1200, maxOutputTokens: 300, maxRetries: 0 },
    }
    expect(task).toEqual(expected)
    expect(observed.runnerConfig).toEqual(expected)
  })

  it('projects an isolated provider, model, and explicit reasoning selection', async () => {
    const { task, observed } = await bootStartup([
      '--provider', 'acme', '--model', 'large', '--reasoning-effort', 'high', 'run',
    ])
    const expected = { task: 'run', selection: { provider: 'acme', model: 'large', reasoningEffort: 'high' } }
    expect(task).toEqual(expected)
    expect(observed.runnerConfig).toEqual(expected)
  })

  it('normalizes provider-default to an absent effort on an explicit route', async () => {
    const { task } = await bootStartup([
      '--provider', 'acme', '--model', 'large', '--reasoning-effort', 'provider-default', 'run',
    ])
    expect(task).toEqual({ task: 'run', selection: { provider: 'acme', model: 'large' } })
  })

  it('keeps reasoning absent when an explicit route omits the flag', async () => {
    const { task } = await bootStartup(['--provider', 'acme', '--model', 'large', 'run'])
    expect(task).toEqual({ task: 'run', selection: { provider: 'acme', model: 'large' } })
  })

  it.each([
    { args: ['--provider', 'acme', 'run'] },
    { args: ['--model', 'large', 'run'] },
    { args: ['--reasoning-effort', 'high', 'run'] },
  ])('rejects an incomplete per-run model selection: $args', async ({ args }) => {
    const { task, observed } = await bootStartup(args)
    expect(observed.out).toContain('--provider and --model must be provided together')
    expect(task).toBeUndefined()
  })

  it('rejects a partial native budget', async () => {
    const { task, observed } = await bootStartup(['--max-turns', '4', 'run'])
    expect(observed.out).toContain('all four budget options must be provided together')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects non-finite and out-of-range native budget flags', async () => {
    const { task, observed } = await bootStartup([
      '--max-turns', 'Infinity',
      '--max-input-tokens', '1',
      '--max-output-tokens', '1',
      '--max-retries', '0',
      'run',
    ])
    expect(observed.out).toContain('positive safe integer')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it.each([{ args: [] }, { args: ['   '] }])('rejects an invocation with no non-whitespace task ($args)', async ({ args }) => {
    const { task, observed } = await bootStartup(args)
    expect(observed.out).toContain('a task is required')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('prints its own help and leaves the runner pending', async () => {
    const { task, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile headless')
    expect(observed.out).toContain('stream reasoning to stderr')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })
})
