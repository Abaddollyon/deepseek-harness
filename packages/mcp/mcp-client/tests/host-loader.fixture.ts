/** Test-only Node process: real built packages and stock Loader, never an import map. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as agentModule from '@deepseek-ai/dsh-mcp-client'

// Include resolves relative to the profile; the parent owns a disposable directory in this package workspace.
const directory = process.argv[2]
assert.ok(directory, 'the test parent must supply its owned profile directory')
const settingsPath = join(directory, 'settings.json')
const hostPath = join(directory, 'cordis.yml')
const agentPath = join(directory, 'agent.cordis.yml')
const contexts: Context[] = []
const originalFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = async () => { networkCalls++; throw new Error('unexpected fixture network access') }
const entry = { url: 'https://fixture.mcp.invalid/mcp', issuerUrl: 'https://fixture.as.invalid', redirectUri: 'https://fixture.client.invalid/callback', scopes: ['mcp'] }

async function boot(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href })
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(hostPath).href } })
  await ctx.loader.await()
  assert.ok(ctx.get('nativeMcpConnections'), 'Host owner was not mounted')
  return ctx
}

try {
  assert.equal('default' in agentModule, false, 'Agent namespace must not unwrap to a Host class')
  assert.equal(typeof agentModule.apply, 'function')
  assert.deepEqual(agentModule.inject, ['tools'])
  await writeFile(settingsPath, JSON.stringify({ 'mcp-connections': { sample: entry } }))
  await writeFile(hostPath, JSON.stringify([
    { id: 'settings', name: '@deepseek-ai/dsh-settings-file', config: { path: settingsPath, watch: false } },
    { id: 'credentials', name: new URL('./credentials-fixture.ts', import.meta.url).href },
    { id: 'authorization', name: '@deepseek-ai/dsh-authorization' },
    { id: 'mcp-host', name: '@deepseek-ai/dsh-mcp-client/host' },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  ]))
  await writeFile(agentPath, JSON.stringify([{ id: 'mcp-agent', name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'host-connection', connectionId: 'sample', serverName: 'sample' } }]))
  const first = await boot()
  const owner = first.get('nativeMcpConnections')!
  assert.equal((await owner.describe('sample'))?.state, 'auth-required')
  assert.ok(first.authorization.describe(owner.recordKeyFor('sample')), 'native flow was not registered')
  const hostModule = await import('@deepseek-ai/dsh-mcp-client/host')
  assert.equal(hostModule.default, agentModule.NativeMcpConnectionsService, 'both public entries must share one Host class identity')
  const agent = createScope(first, {})
  try {
    await agent.ctx.plugin(Include, { path: pathToFileURL(agentPath).href })
    await first.loader.await()
    assert.deepEqual((await owner.describe('sample'))?.consumers, ['sample'])
    // Service handles are context-bound proxies; shared ownership is proven by the Host's consumer ledger.
    assert.deepEqual(await agent.ctx.get('nativeMcpConnections')!.list(), await owner.list())
  } finally { await agent.dispose() }
  assert.deepEqual((await owner.describe('sample'))?.consumers, [])
  await writeFile(agentPath, JSON.stringify([{ id: 'misplaced-host', name: '@deepseek-ai/dsh-mcp-client/host' }]))
  const misplaced = createScope(first, {})
  try {
    await assert.rejects(async () => {
      await misplaced.ctx.plugin(Include, { path: pathToFileURL(agentPath).href })
    }, /Host singleton/)
  } finally { await misplaced.dispose() }
  assert.equal((await owner.describe('sample'))?.state, 'auth-required', 'a refused Agent mount must not damage the Host')
  await first.settings.update('mcp-connections', { sample: { ...entry, label: 'Persisted connection' } })
  const persisted: unknown = JSON.parse(await readFile(settingsPath, 'utf8'))
  assert.deepEqual(persisted, { 'mcp-connections': { sample: { ...entry, label: 'Persisted connection' } } })
  await first.fiber.dispose()
  assert.equal(first.get('nativeMcpConnections'), undefined)
  const second = await boot()
  assert.equal((await second.get('nativeMcpConnections')!.describe('sample'))?.label, 'Persisted connection')
  assert.equal((await second.get('nativeMcpConnections')!.describe('sample'))?.state, 'auth-required')
  await second.settings.replace('mcp-connections', {})
  // Settings publishes before asynchronous engine retirement finishes; wait on the actual ownership view.
  for (let attempt = 0; (await second.get('nativeMcpConnections')!.list()).length > 0 && attempt < 100; attempt++) await delay(5)
  assert.deepEqual(await second.get('nativeMcpConnections')!.list(), [])
  assert.equal(networkCalls, 0)
  console.log('HOST_LOADER_OK')
} finally {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  globalThis.fetch = originalFetch
}
