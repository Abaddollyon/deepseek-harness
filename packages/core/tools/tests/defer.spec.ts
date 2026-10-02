/**
 * Deferred tool declarations: the policy, the SDK index and declaration
 * fragments, `tool_search` inside a program and as a native call (with
 * activation and its resume from the logged request header), and the argument
 * error that carries a deferred tool's declaration.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import ToolRuntime, { RUN_CODE_NAME, TOOL_SEARCH_NAME, defineTool, renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import type { Config, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { byToolName, compileToolDeferPolicy, firstSentence, searchTools } from '../src/defer.ts'
import { renderToolDeclarations } from '../src/ts-types.ts'
import { renderToolDeclarationsPy } from '../src/py-types.ts'
import type { ToolSdkSchema } from '../src/ts-types.ts'

const signal = new AbortController().signal

/** A runtime whose program calls one binding and returns its value. */
class FakeRuntime extends PtcRuntime {
  readonly language: string
  readonly isolation = 'fake'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = () => Promise.resolve({ logs: [] })

  constructor(ctx: Context, config: { language?: string } = {}) {
    super(ctx)
    this.language = config.language ?? 'typescript'
  }

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }

  run(request: PtcRunRequest): Promise<PtcRunResult> {
    return this.behavior(request)
  }
}

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

async function setup(config: Config, language = 'typescript') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, config)
  await ctx.plugin(FakeRuntime, { language })
  for (const name of ['bash', 'gbrain_query', 'gbrain_put_page', 'mcp__home__light_on']) register(ctx, name)
  return { ctx, runtime: ctx.ptcRuntime as FakeRuntime }
}

async function sdkOf(ctx: Context, scope?: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
}

async function wireNames(ctx: Context, scope?: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return assembly.tools.map(tool => tool.name)
}

function call(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal, callId: ToolCallId('call-1'), name, arguments: args, ...agent ? { agent } : {} })
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

const schema = (name: string, description = `The ${name} tool.`): ToolSdkSchema => ({
  name,
  description,
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  output: { type: 'string' },
})

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

describe('the SDK index and declaration fragments', () => {
  it('lists deferred tools after the declarations, one line per small family and one line per large family', () => {
    const large = Array.from({ length: 9 }, (_, index) => ({ name: `cua__tool_${String(index)}`, description: 'Do a thing.' }))
    const sdk = renderToolsSdk([schema('bash')], [
      ...large,
      { name: 'gbrain_put_page', description: 'Write a page. Then index it.' },
      { name: 'mcp__home__light_on', description: '' },
    ])
    const [declarations, index] = sdk.split('## More tools') as [string, string]
    expect(declarations).toContain('  bash: {')
    expect(declarations).not.toContain('gbrain_put_page')
    expect(index).toContain('`console.log((await tools.tool_search({ names: ["cua__tool_0"] })).declarations)`')
    expect(index).toContain('- `cua__*` (9 tools): tool_0, tool_1, tool_2, tool_3, tool_4, tool_5, tool_6, tool_7, tool_8')
    expect(index).toContain('- `gbrain_put_page` — Write a page.')
    expect(index).toMatch(/\n- `mcp__home__light_on`$/u)
    expect(renderToolsSdk([schema('bash')])).not.toContain('## More tools')
  })

  it('renders the Python index with a Python call', () => {
    const sdk = renderToolsSdkPy([schema('bash')], [{ name: 'gbrain_put_page', description: 'Write a page.' }])
    expect(sdk).toContain('print((await tools.tool_search({"names": ["gbrain_put_page"]}))["declarations"])')
    expect(sdk).toContain('- `gbrain_put_page` — Write a page.')
  })

  it('renders fragments that merge into the SDK declarations', () => {
    const ts = renderToolDeclarations([schema('gbrain_put_page')])
    expect(ts).toMatch(/^```ts\ninterface ToolArgsMap \{\n {2}\/\*\* The gbrain_put_page tool\. \*\/\n {2}gbrain_put_page: \{/u)
    expect(ts).toContain('interface ToolOutputMap {\n  gbrain_put_page: string;\n}')
    const py = renderToolDeclarationsPy([schema('gbrain_put_page')])
    expect(py).toMatch(/^```python\nfrom typing import /u)
    expect(py).toContain('class Tools(Protocol):\n    async def gbrain_put_page(self, args: GbrainPutPageArgs) -> str:')
    expect(py).not.toContain('tools: Tools')
  })
})

describe('deferral in the registry', () => {
  it('keeps an omitted deployment policy absent', () => {
    expect(ToolRuntime.Config({})).not.toHaveProperty('defer')
  })

  it('changes nothing without a policy', async () => {
    const { ctx } = await setup({ mode: 'ptc' })
    const sdk = await sdkOf(ctx)
    expect(sdk).toContain('  gbrain_put_page: {')
    expect(sdk).not.toContain('tool_search')
    await expect(call(ctx, TOOL_SEARCH_NAME, { query: 'x' })).resolves.toMatchObject({ isError: true })
  })

  it('declares only loaded tools plus tool_search in the SDK and keeps deferred tools callable', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc', defer: { include: ['gbrain_*', 'mcp__*'], exclude: ['gbrain_query'] } })
    const sdk = await sdkOf(ctx)
    expect(sdk).toContain('  gbrain_query: {')
    expect(sdk).toContain('  tool_search: {')
    expect(sdk).not.toContain('  gbrain_put_page: {')
    expect(sdk).toContain('- `gbrain_put_page` — The gbrain_put_page tool.')
    expect(await wireNames(ctx)).toEqual([RUN_CODE_NAME])

    runtime.behavior = async (request) => {
      const functions = request.bindings[0]!.functions
      const search = await functions[TOOL_SEARCH_NAME]!({ names: ['gbrain_put_page', 'bash'] }) as { tools: string[]; unknown: string[]; declarations: string }
      const written = await functions['gbrain_put_page']!({ value: 'v' })
      return { logs: [search.declarations], value: { tools: search.tools, unknown: search.unknown, written } }
    }
    const result = await call(ctx, RUN_CODE_NAME, { code: 'x', description: 'Look up and call' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('```ts\ninterface ToolArgsMap {')
    expect(text(result)).toContain('"tools": [\n    "gbrain_put_page"\n  ]')
    expect(text(result)).toContain('"unknown": [\n    "bash"\n  ]')
    expect(text(result)).toContain('"written": "gbrain_put_page:v"')
  })

  it('attaches the declaration to a deferred tool\'s argument error, in the SDK format inside a program', async () => {
    const { ctx, runtime } = await setup({ mode: 'ptc', defer: { include: ['gbrain_put_page'] } })
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions['gbrain_put_page']!({})
        return { logs: [] }
      } catch (error) {
        return { logs: [(error as Error).message] }
      }
    }
    const nested = text(await call(ctx, RUN_CODE_NAME, { code: 'x', description: 'Call without args' }))
    expect(nested).toContain('invalid arguments')
    expect(nested).toContain('Declaration of gbrain_put_page:\n```ts\ninterface ToolArgsMap {')

    const native = await setup({ mode: 'native', defer: { include: ['gbrain_put_page'] } })
    const direct = text(await call(native.ctx, 'gbrain_put_page', {}))
    expect(direct).toContain('Declaration of gbrain_put_page:\n{\n  "name": "gbrain_put_page"')
    expect(text(await call(native.ctx, 'bash', {}))).not.toContain('Declaration of')
  })

  it('activates found tools for the calling agent in native presentation, from its next request', async () => {
    const { ctx } = await setup({ mode: 'native', defer: { include: ['gbrain_*', 'mcp__*'] } })
    const agent = agentWith('native-agent')
    const other = agentWith('other-agent')
    for (const scoped of [agent, other]) {
      await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, scoped) }, { inject: ['tools', 'systemPrompt'] }))
    }
    expect(await wireNames(ctx, agent)).toEqual(['bash', TOOL_SEARCH_NAME])

    const result = await call(ctx, TOOL_SEARCH_NAME, { query: 'light' }, agent)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('Declarations for mcp__home__light_on:\n[\n  {\n    "name": "mcp__home__light_on"')
    expect(await wireNames(ctx, agent)).toEqual(['bash', 'mcp__home__light_on', TOOL_SEARCH_NAME])
    expect(await wireNames(ctx, other)).toEqual(['bash', TOOL_SEARCH_NAME])
    await expect(call(ctx, TOOL_SEARCH_NAME, {}, agent)).resolves.toMatchObject({ isError: true })
    await expect(call(ctx, TOOL_SEARCH_NAME, { names: [], query: '  ' }, agent)).resolves.toMatchObject({ isError: true })
    expect(text(await call(ctx, TOOL_SEARCH_NAME, { names: ['bash', 'nothing'] }, agent)))
      .toBe('No deferred tool matched.\nNot deferred tools of this agent: bash, nothing')
    // A call with no agent has no one to activate for.
    expect(text(await call(ctx, TOOL_SEARCH_NAME, { names: ['gbrain_put_page'] }))).toContain('Declarations for gbrain_put_page:')
    expect(await wireNames(ctx)).toEqual(['bash', TOOL_SEARCH_NAME])
  })

  it('lists deferred tools by name for a native agent, unchanged by its activations', async () => {
    const { ctx } = await setup({ mode: 'native', defer: { include: ['gbrain_*', 'mcp__*'] } })
    const agent = agentWith('native-index')
    await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
    const index = async (): Promise<string> => (await ctx.systemPrompt.assemble({ scope: agent })).sections
      .find(section => section.name === 'tools:deferred')?.text ?? ''
    const before = await index()
    expect(before).toBe([
      '## More tools',
      '',
      'These tools are available but not in your tool list. Call `tool_search` with their exact `names` (or a keyword `query`) to add their declarations; you can call them from your next step, for example `tool_search({"names": ["gbrain_put_page"]})`.',
      '',
      '- `gbrain_put_page` — The gbrain_put_page tool.',
      '- `gbrain_query` — The gbrain_query tool.',
      '- `mcp__home__light_on` — The mcp__home__light_on tool.',
    ].join('\n'))
    expect(await sdkOf(ctx, agent)).toBe('')
    await call(ctx, TOOL_SEARCH_NAME, { names: ['mcp__home__light_on'] }, agent)
    expect(await wireNames(ctx, agent)).toContain('mcp__home__light_on')
    expect(await index()).toBe(before)

    // PTC carries the index in its SDK, and nothing deferred renders nothing.
    for (const config of [{ mode: 'ptc', defer: { include: ['gbrain_*'] } }, { mode: 'native' }] as const) {
      const other = await setup(config)
      expect((await other.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tools:deferred')?.text).toBe('')
    }
  })

  it('restores a resumed agent\'s activations from the tools its logged request header declared', async () => {
    const { ctx } = await setup({ mode: 'native', defer: { include: ['gbrain_*'] } })
    const resumed = agentWith('resumed', { tools: [{ name: 'bash', description: '', parameters: {} }, { name: 'gbrain_put_page', description: '', parameters: {} }] })
    const fresh = agentWith('fresh')
    for (const scoped of [resumed, fresh]) {
      await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, scoped) }, { inject: ['tools', 'systemPrompt'] }))
      await ctx.serial('agent/created', { agent: scoped, source: 'resume' } as never)
    }
    expect(await wireNames(ctx, resumed)).toEqual(['bash', 'gbrain_put_page', 'mcp__home__light_on', TOOL_SEARCH_NAME])
    expect(await wireNames(ctx, fresh)).toEqual(['bash', 'mcp__home__light_on', TOOL_SEARCH_NAME])
  })

  it('shadows the deployment policy per scope and rejects a second declaration or an unscoped one', async () => {
    const { ctx } = await setup({ mode: 'ptc', defer: { include: ['gbrain_*'] } })
    const agent = agentWith('scoped')
    let scoped!: Context
    await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, { inject: ['tools', 'systemPrompt'] }))
    const dispose = scoped.tools.deferAs({ include: ['bash'] })
    expect(() => scoped.tools.deferAs({ include: ['x'] })).toThrow(/already declared/)
    expect(() => ctx.tools.deferAs({ include: ['x'] })).toThrow(/requires a scoped context/)
    const sdk = await sdkOf(ctx, agent)
    expect(sdk).toContain('  gbrain_put_page: {')
    expect(sdk).toContain('- `bash` — The bash tool.')
    dispose()
    expect(await sdkOf(ctx, agent)).toContain('- `gbrain_put_page` — The gbrain_put_page tool.')
    expect(() => { register(ctx, TOOL_SEARCH_NAME) }).toThrow(/reserved for deferred tool lookup/)
  })
})
