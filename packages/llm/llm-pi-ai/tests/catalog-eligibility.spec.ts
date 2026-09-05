import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as LlmPiAi from '../src/index.ts'
import { assemble } from './assemble.ts'
import { textEvents } from './mock-server.ts'

const provider = 'openai-codex'
const installed = 'gpt-5.3-codex-spark'
const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const visible = (slug: string) => ({ slug, visibility: 'list', supported_in_api: true, context_window: 123456 })
const hidden = (slug: string) => ({ slug, visibility: 'hide', supported_in_api: false, instructions: 'UNTRUSTED PROMPT' })
const token = (account: string): string => `fake.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: account },
})).toString('base64url')}.sig`

async function boot(root?: string, profile: Partial<LlmPiAi.PiAiProviderProfile> = {}): Promise<Context> {
  if (root === undefined) {
    root = await mkdtemp(join(tmpdir(), 'pi-eligibility-'))
    roots.push(root)
  }
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(root, 'credentials.yaml'), watch: false })
  if (await ctx.credentials.readRecord(LlmPiAi.recordKeyFor(provider)) === undefined) {
    await ctx.credentials.modifyRecord(LlmPiAi.recordKeyFor(provider), async () => ({ kind: 'grant', payload: {
      type: 'oauth', access: token('account-a'), refresh: 'synthetic-refresh-a', expires: Date.now() + 600_000,
    } }))
  }
  await ctx.plugin(LlmPiAi, { providers: { [provider]: {
    api: 'openai-completions', baseURL: 'https://synthetic.invalid',
    modelDiscovery: { enabled: true }, ...profile,
  } } })
  return ctx
}

function fixture(initial: unknown[]) {
  const state = { rows: initial, offline: false, rotations: 0 }
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname.endsWith('/token')) {
      state.rotations++
      return Response.json({ access_token: token('renewed-a'), refresh_token: 'synthetic-renewal', expires_in: 3600 })
    }
    if (url.pathname.endsWith('/chat/completions')) {
      return new Response(textEvents.map(event => `data: ${event}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    if (state.offline) throw new Error('synthetic offline')
    if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.153.2' })
    return Response.json({ models: state.rows })
  })
  return state
}

const refresh = (ctx: Context) => ctx.llm.discoverModels('llm-pi-ai', { provider })
const ids = async (ctx: Context) => (await ctx.llm.listModels(provider)).map(model => model.id)

describe('Codex selectable eligibility', () => {
  it('excludes installed fallback choices while retaining current-choice resolution and prepared dispatch', async () => {
    fixture([{ ...visible(installed), supported_in_api: false }, visible('available')])
    const ctx = await boot()
    const candidates = await refresh(ctx)
    expect(candidates.map(model => model.id)).not.toContain(installed)
    expect(await ids(ctx)).not.toContain(installed)
    for (const id of [installed, 'available']) {
      expect((await ctx.llm.resolveModelInfo(provider, id)).id).toBe(id)
      const prepared = await ctx.llm.prepareCall({ provider, model: id })
      expect(prepared.config.model).toBe(id)
      const assembled = new BlockAssembler()
      for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) assembled.push(chunk)
      expect(assembled.message({ kind: 'model', provider, model: id }).content).toEqual([{ type: 'text', text: 'hello' }])
      expect((await assemble(ctx, { provider, model: id, messages: [] })).message.content).toEqual([{ type: 'text', text: 'hello' }])
    }
  })

  it('retains exclusions and omitted metadata offline, then allows a valid positive row to restore eligibility', async () => {
    const state = fixture([visible('formerly-visible'), visible('omitted'), visible('available')])
    const ctx = await boot()
    await refresh(ctx)
    state.rows = [hidden('formerly-visible'), hidden(installed), visible('available')]
    await refresh(ctx)
    expect(await ids(ctx)).not.toContain('formerly-visible')
    expect(await ids(ctx)).toContain('omitted')
    expect((await ctx.llm.resolveModelInfo(provider, 'formerly-visible')).context?.contextWindow).toBe(123456)
    const cachePath = join(roots[0]!, 'cache', 'llm-pi-ai')
    const saved = await readFile(join(cachePath, (await readdir(cachePath))[0]!), 'utf8')
    expect(JSON.parse(saved)).toMatchObject({ excludedIds: ['formerly-visible', installed] })
    expect(saved).not.toContain('UNTRUSTED PROMPT')
    for (const invalid of [[], [{ slug: 'formerly-visible' }], [visible('formerly-visible'), null]]) {
      state.rows = invalid
      await expect(refresh(ctx)).rejects.toThrow(/discovery/)
      expect(await ids(ctx)).not.toContain('formerly-visible')
    }
    await ctx.fiber.dispose()
    state.offline = true
    const restarted = await boot(roots[0])
    await expect(refresh(restarted)).rejects.toThrow(/discovery/)
    expect(await ids(restarted)).not.toContain('formerly-visible')
    expect(await ids(restarted)).not.toContain(installed)
    expect(await ids(restarted)).toContain('omitted')
    expect((await restarted.llm.prepareCall({ provider, model: 'formerly-visible' })).config.model).toBe('formerly-visible')
    state.offline = false
    state.rows = [visible('formerly-visible'), visible(installed)]
    await refresh(restarted)
    expect(await ids(restarted)).toEqual(expect.arrayContaining(['formerly-visible', installed, 'omitted']))
    const cache = join(roots[0]!, 'cache', 'llm-pi-ai')
    for (const file of await readdir(cache)) {
      const body = await readFile(join(cache, file), 'utf8')
      expect(body).not.toContain('UNTRUSTED PROMPT')
      expect(body).not.toContain('synthetic-refresh')
      expect(body).not.toContain(token('account-a'))
    }
  })

  it.each(['models', 'modelOverrides'] as const)('preserves explicit %s settings and output overrides', async (kind) => {
    fixture([hidden(installed), visible('available')])
    const profile = kind === 'models' ? { models: [{ id: installed, maxTokens: 1234 }] }
      : { modelOverrides: { [installed]: { maxTokens: 1234 } } }
    const ctx = await boot(undefined, profile)
    await ctx.settings.update('llm-pi-ai', { providers: { [provider]: profile } })
    const before = JSON.stringify(ctx.settings.get('llm-pi-ai'))
    await refresh(ctx)
    expect(await ids(ctx)).toContain(installed)
    expect((await ctx.llm.prepareCall({ provider, model: installed })).config.maxTokens).toBe(1234)
    expect(JSON.stringify(ctx.settings.get('llm-pi-ai'))).toBe(before)
  })

  it('keeps exclusions through verified OAuth renewal but fences them after an external account replacement', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const state = fixture([hidden(installed), visible('available')])
    const ctx = await boot()
    await refresh(ctx)
    now += 1_200_000
    state.offline = true
    await expect(refresh(ctx)).rejects.toThrow(/discovery/)
    expect(state.rotations).toBe(1)
    expect(await ids(ctx)).not.toContain(installed)
    await ctx.fiber.dispose()
    const restarted = await boot(roots[0])
    await expect(refresh(restarted)).rejects.toThrow(/discovery/)
    expect(await ids(restarted)).not.toContain(installed)
    await restarted.credentials.modifyRecord(LlmPiAi.recordKeyFor(provider), async () => ({ kind: 'grant', payload: {
      type: 'oauth', access: token('account-b'), refresh: 'synthetic-refresh-b', expires: now + 3_600_000,
    } }))
    await expect(refresh(restarted)).rejects.toThrow(/discovery/)
    expect(await ids(restarted)).toContain(installed)
    expect(await ids(restarted)).not.toContain('available')
  })

  it('bounds retained exclusion IDs together with metadata and preserves the last-good catalog on overflow', async () => {
    const state = fixture([hidden(installed), visible('available')])
    const ctx = await boot()
    await refresh(ctx)
    state.rows = Array.from({ length: 2000 }, (_, index) => hidden(`excluded-${index}`))
    await expect(refresh(ctx)).rejects.toThrow(/discovery/)
    expect(await ids(ctx)).not.toContain(installed)
    expect(await ids(ctx)).toContain('available')
  })

  it('accepts an exclusion-only response and fences its cache when the route configuration changes', async () => {
    const state = fixture([hidden(installed)])
    const ctx = await boot()
    await refresh(ctx)
    expect(await ids(ctx)).not.toContain(installed)
    await ctx.fiber.dispose()
    state.offline = true
    const restarted = await boot(roots[0])
    await expect(refresh(restarted)).rejects.toThrow(/discovery/)
    expect(await ids(restarted)).not.toContain(installed)
    await restarted.settings.update('llm-pi-ai', { providers: { [provider]: { baseURL: 'https://other.synthetic.invalid' } } })
    await expect(refresh(restarted)).rejects.toThrow(/discovery/)
    expect(await ids(restarted)).toContain(installed)
  })

  it.each([
    [null], [''], ['x'.repeat(513)], Array.from({ length: 2001 }, (_, index) => `invalid-${index}`),
  ])('rejects invalid durable exclusion IDs %# without adopting their metadata', async (...excludedIds) => {
    const state = fixture([hidden(installed), visible('available')])
    const ctx = await boot()
    await refresh(ctx)
    await ctx.fiber.dispose()
    const cache = join(roots[0]!, 'cache', 'llm-pi-ai')
    const filename = join(cache, (await readdir(cache))[0]!)
    const saved = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>
    await writeFile(filename, JSON.stringify({ ...saved, excludedIds }))
    state.offline = true
    const restarted = await boot(roots[0])
    await expect(refresh(restarted)).rejects.toThrow(/discovery/)
    expect(await ids(restarted)).toContain(installed)
    expect(await ids(restarted)).not.toContain('available')
  })
})
