import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import RunSupervisor from '@deepseek-ai/dsh-run-supervisor'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot a real Loader composition over the two rows the host plane carries. */
async function bootLoader(supervisorConfig: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-run-supervisor-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-jobs-local'",
    supervisorConfig,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(AgentRegistry)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-jobs-local') return LocalJobRegistry
      if (specifier === '@deepseek-ai/dsh-run-supervisor') return RunSupervisor
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('RunSupervisor through a real Loader composition', () => {
  it('loads with its schemastery-defaulted config from a Cordis row', async () => {
    const ctx = await bootLoader([
      "- name: '@deepseek-ai/dsh-run-supervisor'",
      '  config:',
      '    maxResumedRunsPerOwner: 3',
    ].join('\n'))
    expect(ctx.jobs).toBeInstanceOf(LocalJobRegistry)
    expect(ctx.registry.has(RunSupervisor)).toBe(true)
  })

  it('fails loud at load when the config violates the schema', async () => {
    await expect(bootLoader([
      "- name: '@deepseek-ai/dsh-run-supervisor'",
      '  config:',
      '    bootResumeTimeoutMs: 0',
    ].join('\n'))).rejects.toThrow()
  })
})
