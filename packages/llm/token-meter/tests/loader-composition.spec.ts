/**
 * REAL-composition proof: the shipped YAML shape (session + projection
 * registry + token-meter) boots through the vendored Loader and serves the
 * package's four projection keys, with `modelRoute` absent-as-null before the
 * first request and published on the change feed the moment a route resolves.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-token-meter-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
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

const SHIPPED_SHAPE = [
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-session-projection'",
  "- name: '@deepseek-ai/dsh-token-meter'",
]

describe('real Loader composition', () => {
  it('loads the shipped token-meter YAML shape and serves the route of the composed session', async () => {
    const loaded = await loadYaml(SHIPPED_SHAPE)

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const published: unknown[] = []
    loaded.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'modelRoute') published.push(value)
    })

    const session = loaded.sessions.create(SessionId('composed'))
    expect(loaded.sessionProjections.snapshot(session).values.modelRoute).toBeNull()

    session.append('request/context', { provider: 'composed-provider', model: 'composed-model', contextWindow: 8192 })
    expect(loaded.sessionProjections.snapshot(session).values.modelRoute)
      .toEqual({ provider: 'composed-provider', model: 'composed-model', contextWindow: 8192 })

    session.append('request/context', { provider: 'other-provider', model: 'other-model' })
    expect(published).toEqual([
      { provider: 'composed-provider', model: 'composed-model', contextWindow: 8192 },
      { provider: 'other-provider', model: 'other-model' },
    ])
  })

  it('registers every projection key the package owns', async () => {
    const loaded = await loadYaml(SHIPPED_SHAPE)
    const session = loaded.sessions.create(SessionId('keys'))
    expect(Object.keys(loaded.sessionProjections.snapshot(session).values).sort())
      .toEqual(['contextBreakdown', 'contextPressure', 'modelRoute', 'tokenUsage'])
  })
})
