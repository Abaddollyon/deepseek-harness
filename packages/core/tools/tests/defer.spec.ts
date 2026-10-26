/**
 * Deferred tool declarations in the registry: the policy, `tool_search` as a
 * native call (with activation and its resume from the logged request
 * header), the native index section, and the argument error that carries a
 * deferred tool's declaration. The PTC SDK side lives in the PTC executor's
 * defer spec.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { TOOL_ORDER_REST } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_SEARCH_NAME, ToolArgsError, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDeferConfig, ToolExecution, ToolExecutionResult, ToolExecutor } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { byToolName, compileToolDeferPolicy, firstSentence, searchTools } from '../src/defer.ts'

const signal = new AbortController().signal

/** A logged request header the resume seeding reads, or none for a new Session. */
type LoggedHeader = { tools?: ToolSchema[] } | undefined

function agentWith(id: string, header?: LoggedHeader): Agent {
  const session = Session.create(SessionId(id))
  vi.spyOn(session, 'requestHeader').mockReturnValue(header as ReturnType<Session['requestHeader']>)
  return { id: session.id, session } as Agent
}

function register(ctx: Context, name: string, description = `The ${name} tool. More detail follows here.`): void {
  ctx.tools.register(defineTool({
    name,
    description,
    parameters: { value: { type: 'string', required: true, description: 'The value.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(`${name}:${args.value}`),
  }))
}

async function setup(defer?: ToolDeferConfig) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, defer === undefined ? {} : { defer })
  await ctx.plugin(NativeToolExecutor)
  for (const name of ['bash', 'gbrain_query', 'gbrain_put_page', 'mcp__home__light_on']) register(ctx, name)
  return { ctx }
}

/** Mount an agent scope under `ctx` and return its context. */
async function scopeOf(ctx: Context, agent: Agent): Promise<Context> {
  let scoped!: Context
  await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, { inject: ['tools', 'systemPrompt'] }))
  return scoped
}

async function wireNames(ctx: Context, scope?: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return assembly.tools.map(tool => tool.name)
}

async function indexOf(ctx: Context, scope?: Agent): Promise<string | undefined> {
  return (await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })).sections.find(section => section.name === 'tools:deferred')?.text
}

function call(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent): Promise<ToolExecutionResult> {
  return executeModelToolFixture(ctx, { signal, callId: ToolCallId('call-1'), name, arguments: args, ...agent ? { agent } : {} })
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

describe('the defer policy', () => {
  it('defers included names and deferLoading tools unless excluded, with whole-name `*` patterns', () => {
    const policy = compileToolDeferPolicy({ include: ['gbrain_*', 'mcp__*'], exclude: ['gbrain_query', 'pinned'] })
    expect(policy.defers('gbrain_put_page', false)).toBe(true)
    expect(policy.defers('gbrain_query', false)).toBe(false)
    expect(policy.defers('mcp__home__light_on', false)).toBe(true)
    expect(policy.defers('xgbrain_put', false)).toBe(false)
    expect(policy.defers('flagged', true)).toBe(true)
    expect(policy.defers('pinned', true)).toBe(false)
    expect(compileToolDeferPolicy({ include: ['a.b'] }).defers('axb', false)).toBe(false)
    expect(() => compileToolDeferPolicy({ include: [''] })).toThrow(/non-empty/)
  })

  it('keeps one capped sentence for the index', () => {
    expect(firstSentence('Run a query.  Then more.')).toBe('Run a query.')
    expect(firstSentence('No full stop here')).toBe('No full stop here')
    expect(firstSentence(`${'x'.repeat(150)}.`)).toHaveLength(100)
    expect(firstSentence('Version 1.5 ships. Then more.')).toBe('Version 1.5 ships.')
  })

  it('finds exact names first, then keyword matches on names before descriptions, capped at ten', () => {
    const candidates = [
      { name: 'light_on', description: 'Turn a light on.' },
      { name: 'media_play', description: 'Play media in a room with lights.' },
      ...Array.from({ length: 12 }, (_, index) => ({ name: `light_${String(index).padStart(2, '0')}`, description: 'x' })),
    ]
    const exact = searchTools(candidates, ['media_play', 'missing'], undefined)
    expect(exact.found.map(entry => entry.name)).toEqual(['media_play'])
    expect(exact.unknown).toEqual(['missing'])
    expect(searchTools(candidates, undefined, 'PLAY media').found.map(entry => entry.name)).toEqual(['media_play'])
    const keyword = searchTools(candidates, undefined, 'light')
    expect(keyword.found).toHaveLength(10)
    expect(keyword.found.every(entry => entry.name.startsWith('light_'))).toBe(true)
    expect(byToolName({ name: 'a' }, { name: 'a' })).toBe(0)
  })
})

describe('deferral in the registry', () => {
  it('keeps an omitted deployment policy absent', () => {
    expect(ToolRuntime.Config({})).not.toHaveProperty('defer')
  })

  it('changes nothing without a policy', async () => {
    const { ctx } = await setup()
    expect(await wireNames(ctx)).toEqual(['bash', 'gbrain_put_page', 'gbrain_query', 'mcp__home__light_on'])
    expect(ctx.tools.get(TOOL_SEARCH_NAME)).toBeUndefined()
    await expect(call(ctx, TOOL_SEARCH_NAME, { query: 'x' })).resolves.toMatchObject({ isError: true })
  })

  it('attaches the JSON declaration to a deferred tool\'s argument error on a direct call', async () => {
    const { ctx } = await setup({ include: ['gbrain_put_page'] })
    const direct = text(await call(ctx, 'gbrain_put_page', {}))
    expect(direct).toContain('invalid arguments')
    expect(direct).toContain('Declaration of gbrain_put_page:\n{\n  "name": "gbrain_put_page"')
    expect(text(await call(ctx, 'bash', {}))).not.toContain('Declaration of')
    // A declared tool's argument error passes through unchanged.
    const declared = new ToolArgsError(['value: required'])
    expect(ctx.tools.explainArgsError(declared, { name: 'bash' } as ToolExecution)).toBe(declared)
  })

  it('activates found tools for the calling agent from its next request', async () => {
    const { ctx } = await setup({ include: ['gbrain_*', 'mcp__*'] })
    const agent = agentWith('native-agent')
    const other = agentWith('other-agent')
    for (const scoped of [agent, other]) await scopeOf(ctx, scoped)
    expect(await wireNames(ctx, agent)).toEqual(['bash', TOOL_SEARCH_NAME])
    expect(ctx.tools.get(TOOL_SEARCH_NAME, agent)?.name).toBe(TOOL_SEARCH_NAME)

    const result = await call(ctx, TOOL_SEARCH_NAME, { query: 'light' }, agent)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Declarations for mcp__home__light_on:\n[\n  {\n    "name": "mcp__home__light_on"')
    expect(await wireNames(ctx, agent)).toEqual(['bash', 'mcp__home__light_on', TOOL_SEARCH_NAME])
    expect(await wireNames(ctx, other)).toEqual(['bash', TOOL_SEARCH_NAME])
    await call(ctx, TOOL_SEARCH_NAME, { names: ['gbrain_put_page'] }, agent)
    expect(await wireNames(ctx, agent)).toEqual(['bash', 'gbrain_put_page', 'mcp__home__light_on', TOOL_SEARCH_NAME])
    await expect(call(ctx, TOOL_SEARCH_NAME, {}, agent)).resolves.toMatchObject({ isError: true })
    await expect(call(ctx, TOOL_SEARCH_NAME, { names: [], query: '  ' }, agent)).resolves.toMatchObject({ isError: true })
    expect(text(await call(ctx, TOOL_SEARCH_NAME, { names: ['bash', 'nothing'] }, agent)))
      .toBe('No deferred tool matched.\nNot deferred tools of this agent: bash, nothing')
    // A call with no agent has no one to activate for.
    expect(text(await call(ctx, TOOL_SEARCH_NAME, { names: ['gbrain_put_page'] }))).toContain('Declarations for gbrain_put_page:')
    expect(await wireNames(ctx)).toEqual(['bash', TOOL_SEARCH_NAME])
  })

  it('lists deferred tools by name for a native agent, unchanged by its activations', async () => {
    const { ctx } = await setup({ include: ['gbrain_*', 'mcp__*'] })
    const agent = agentWith('native-index')
    await scopeOf(ctx, agent)
    const before = await indexOf(ctx, agent)
    expect(before).toBe([
      '## More tools',
      '',
      'These tools are available but not in your tool list. Call `tool_search` with their exact `names` (or a keyword `query`) to add their declarations; you can call them from your next step, for example `tool_search({"names": ["gbrain_put_page"]})`.',
      '',
      '- `gbrain_put_page` — The gbrain_put_page tool.',
      '- `gbrain_query` — The gbrain_query tool.',
      '- `mcp__home__light_on` — The mcp__home__light_on tool.',
    ].join('\n'))
    await call(ctx, TOOL_SEARCH_NAME, { names: ['mcp__home__light_on'] }, agent)
    expect(await wireNames(ctx, agent)).toContain('mcp__home__light_on')
    expect(await indexOf(ctx, agent)).toBe(before)

    // A registry that cannot defer anything registers no index section at all.
    const plain = await setup()
    expect((await plain.ctx.systemPrompt.assemble()).sections.map(section => section.name)).not.toContain('tools:deferred')
  })

  it('renders the index only through an executor that lists deferred tools there', async () => {
    const { ctx } = await setup({ include: ['gbrain_*'] })
    const agent = agentWith('declares-all')
    const scoped = await scopeOf(ctx, agent)
    const declaresAll: ToolExecutor = {
      describe: tools => ({ schemas: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
      execute: () => Promise.reject(new Error('not called')),
    }
    scoped.tools.setExecutor(declaresAll)
    expect(await indexOf(ctx, agent)).toBe('')
    expect(await wireNames(ctx, agent)).toEqual(['bash', 'gbrain_put_page', 'gbrain_query', 'mcp__home__light_on', TOOL_SEARCH_NAME])
  })

  it('registers the native index for a scoped policy and on the first deferLoading tool', async () => {
    const scoped = await setup()
    const agent = agentWith('scoped-index')
    const agentCtx = await scopeOf(scoped.ctx, agent)
    const dispose = agentCtx.tools.deferAs({ include: ['gbrain_put_page'] })
    expect(await indexOf(scoped.ctx, agent)).toContain('- `gbrain_put_page` — The gbrain_put_page tool.')
    expect(await indexOf(scoped.ctx)).toBeUndefined()
    dispose()
    expect(await indexOf(scoped.ctx, agent)).toBeUndefined()

    const flagged = await setup()
    for (const name of ['flagged', 'flagged_too']) {
      flagged.ctx.tools.register(defineTool({
        name,
        description: `The ${name} tool.`,
        parameters: {},
        deferLoading: true,
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => Promise.resolve('ok'),
      }))
    }
    expect(await indexOf(flagged.ctx)).toContain('- `flagged` — The flagged tool.\n- `flagged_too` — The flagged_too tool.')

    // A policy that matches no visible tool renders an empty index and no lookup.
    const unmatched = await setup({ include: ['nothing_*'] })
    expect(await indexOf(unmatched.ctx)).toBe('')
    expect(await wireNames(unmatched.ctx)).not.toContain(TOOL_SEARCH_NAME)
  })

  it('restores a resumed agent\'s activations from the tools its logged request header declared', async () => {
    const { ctx } = await setup({ include: ['gbrain_*'] })
    const resumed = agentWith('resumed', { tools: [{ name: 'bash', description: '', parameters: {} }, { name: 'gbrain_put_page', description: '', parameters: {} }] })
    const fresh = agentWith('fresh')
    for (const scoped of [resumed, fresh]) {
      await scopeOf(ctx, scoped)
      await ctx.serial('agent/created', { agent: scoped, source: 'resume' } as never)
    }
    expect(await wireNames(ctx, resumed)).toEqual(['bash', 'gbrain_put_page', 'mcp__home__light_on', TOOL_SEARCH_NAME])
    expect(await wireNames(ctx, fresh)).toEqual(['bash', 'mcp__home__light_on', TOOL_SEARCH_NAME])
  })

  it('seeds nothing from an agent whose Session has no request-header history', async () => {
    const { ctx } = await setup({ include: ['gbrain_*'] })
    const standIn = { id: SessionId('stand-in'), session: {} as Agent['session'] } as Agent
    const sessionless = { id: SessionId('sessionless') } as Agent
    for (const agent of [standIn, sessionless]) {
      await scopeOf(ctx, agent)
      await ctx.serial('agent/created', { agent, source: 'create' } as never)
      expect(await wireNames(ctx, agent)).toEqual(['bash', 'mcp__home__light_on', TOOL_SEARCH_NAME])
    }
  })

  it('shadows the deployment policy per scope and rejects a second declaration, an unscoped one, or the reserved name', async () => {
    const { ctx } = await setup({ include: ['gbrain_*'] })
    const agent = agentWith('scoped')
    const scoped = await scopeOf(ctx, agent)
    const dispose = scoped.tools.deferAs({ include: ['bash'] })
    expect(() => scoped.tools.deferAs({ include: ['x'] })).toThrow(/already declared/)
    expect(() => ctx.tools.deferAs({ include: ['x'] })).toThrow(/requires a scoped context/)
    expect(await wireNames(ctx, agent)).toEqual(['gbrain_put_page', 'gbrain_query', 'mcp__home__light_on', TOOL_SEARCH_NAME])
    expect(await indexOf(ctx, agent)).toContain('- `bash` — The bash tool.')
    dispose()
    expect(await wireNames(ctx, agent)).toEqual(['bash', 'mcp__home__light_on', TOOL_SEARCH_NAME])
    expect(() => { register(ctx, TOOL_SEARCH_NAME) }).toThrow(/reserved for deferred tool lookup/)
  })

  it('lists tool_search where toolOrder may name it', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { toolOrder: [TOOL_SEARCH_NAME, TOOL_ORDER_REST] })
      await ctx.plugin(ToolRuntime, { defer: { include: ['gbrain_*'] } })
      await ctx.plugin(NativeToolExecutor)
      for (const name of ['bash', 'gbrain_query']) register(ctx, name)
      expect(await wireNames(ctx)).toEqual([TOOL_SEARCH_NAME, 'bash'])
    } finally { await ctx.fiber.dispose() }
  })
})
