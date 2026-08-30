import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as tool from '../src/index.ts'
import * as scriptedProvider from './scripted-provider.ts'
import { callSubagent, text } from './harness.ts'

/**
 * REAL-composition coverage: a test-only cordis.yml booted through the Cordis
 * Loader assembles the shipping tool-subagent consumer and the scripted
 * provider plugin, so the structured provider failure crosses provider,
 * service, and tool boundaries exactly as deployment composition delivers it.
 */

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-subagent-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-subagent'",
    "- name: '@deepseek-ai/dsh-tool-subagent'",
    '  config:',
    '    provider: mock',
    "- name: '@fixture/scripted-subagent-provider'",
    '  config:',
    '    name: mock',
    '    reply: partial child answer',
    '    stopReason: error',
    '    diagnostic: provider quota exhausted on this route',
    '    failure:',
    '      code: QUOTA',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-tool-subagent', tool],
    ['@fixture/scripted-subagent-provider', scriptedProvider],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('tool-subagent Loader composition', () => {
  it('preserves the structured provider failure through the composed tool end to end', async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/end', info => void ends.push(info))
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })

    // The lifecycle edge keeps the typed failure machine-readable for
    // programmatic consumers of the same run the tool reports.
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ stopReason: 'error', failure: { code: 'QUOTA' } })

    // The parent model receives one error result whose text carries the
    // branchable failure code between the bounded diagnostic and the child's
    // preserved partial answer.
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected foreground failure')
    expect(text(result)).toBe(
      'Error: subagent run failed\n'
      + 'Diagnostic: provider quota exhausted on this route\n'
      + 'Failure code: QUOTA\n'
      + 'Partial output before the run ended:\npartial child answer',
    )
    expect(result.error?.message).toContain('Failure code: QUOTA')
  })
})
