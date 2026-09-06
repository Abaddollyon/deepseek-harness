import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import config from '../tsdown.config.ts'

async function forFace(face?: 'host' | 'client') {
  const resolved = typeof config === 'function'
    ? await config({ env: face ? { DSH_BUILD_FACE: face } : {} }, { ci: false })
    : config
  if (Array.isArray(resolved)) throw new Error('expected one MCP build configuration')
  return resolved
}

it.each(['host', undefined] as const)('builds both public roles together on face %s', async (face) => {
  const host = await forFace(face)
  expect(host.entry).toEqual({ index: 'lib/types/index.js', host: 'lib/types/host.js' })
  expect(host).not.toHaveProperty('plugins')
  expect(host.clean).toEqual(['lib/*.js'])
  const manifest: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest).toHaveProperty('files', ['lib/index.js', 'lib/host.js', 'lib/connections-*.js', 'lib/types/**/*.d.ts'])
})

it('skips the Client pass without cleaning or overwriting Host artifacts', async () => {
  expect(await forFace('client')).toEqual({ entry: '' })
})
