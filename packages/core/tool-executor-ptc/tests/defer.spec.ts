/**
 * Deferred tools under the PTC executor: the SDK index and declaration
 * fragments, `tool_search` inside a program, the argument error a program
 * reads, and an SDK that ignores activations made while the scope presented
 * natively. The registry policy lives in the tools package's defer spec.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import ToolRuntime, { RUN_CODE_NAME, TOOL_SEARCH_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDeferConfig, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as PtcToolExecutor from '../src/index.ts'
import { renderToolDeclarations } from '../src/ts-types.ts'
import type { ToolSdkSchema } from '../src/ts-types.ts'
import { renderToolDeclarationsPy } from '../src/py-types.ts'

const { renderToolsSdk, renderToolsSdkPy } = PtcToolExecutor
const signal = new AbortController().signal

/** A runtime whose program the test scripts through `behavior`. */
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

function register(ctx: Context, name: string): void {
  ctx.tools.register(defineTool({
    name,
    description: `The ${name} tool. More detail follows here.`,
    parameters: { value: { type: 'string', required: true, description: 'The value.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(`${name}:${args.value}`),
  }))
}

async function setup(mode: 'native' | 'ptc', defer?: ToolDeferConfig, language = 'typescript') {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, defer === undefined ? {} : { defer })
  await ctx.plugin(FakeRuntime, { language })
  if (mode === 'native') await ctx.plugin(NativeToolExecutor)
  else await ctx.plugin(PtcToolExecutor)
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
  return executeModelToolFixture(ctx, { signal, callId: ToolCallId('call-1'), name, arguments: args, ...agent ? { agent } : {} })
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

describe('the SDK index and declaration fragments', () => {
  it('lists deferred tools after the declarations, one line per small family and one line per large family', () => {
    const large = Array.from({ length: 9 }, (_, index) => ({ name: `cua__tool_${String(index)}`, description: 'Do a thing.' }))
    const sdk = renderToolsSdk([schema('bash')], 'function-body', [
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

describe('deferral under the PTC executor', () => {
  it('changes nothing without a policy', async () => {
    const { ctx } = await setup('ptc')
    const sdk = await sdkOf(ctx)
    expect(sdk).toContain('  gbrain_put_page: {')
    expect(sdk).not.toContain('tool_search')
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name)).not.toContain('tools:deferred')
  })

  it('declares only loaded tools plus tool_search in the SDK and keeps deferred tools callable', async () => {
    const { ctx, runtime } = await setup('ptc', { include: ['gbrain_*', 'mcp__*'], exclude: ['gbrain_query'] })
    const sdk = await sdkOf(ctx)
    expect(sdk).toContain('  gbrain_query: {')
    expect(sdk).toContain('  tool_search: {')
    expect(sdk).not.toContain('  gbrain_put_page: {')
    expect(sdk).toContain('- `gbrain_put_page` — The gbrain_put_page tool.')
    expect(await wireNames(ctx)).toEqual([RUN_CODE_NAME])
    // The SDK carries the index, so the registry's index section stays empty.
    expect((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tools:deferred')?.text).toBe('')

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
    // A direct tool_search call is refused like any other non-transport call.
    expect(text(await call(ctx, TOOL_SEARCH_NAME, { names: ['gbrain_put_page'] }))).toContain(`only \`${RUN_CODE_NAME}\` is callable directly`)
  })

  it('returns Python declarations to a Python program', async () => {
    const { ctx, runtime } = await setup('ptc', { include: ['gbrain_put_page'] }, 'python')
    runtime.behavior = async (request) => {
      const search = await request.bindings[0]!.functions[TOOL_SEARCH_NAME]!({ names: ['gbrain_put_page'] }) as { declarations: string }
      return { logs: [search.declarations] }
    }
    expect(text(await call(ctx, RUN_CODE_NAME, { code: 'x', description: 'Look up' })))
      .toContain('```python\nfrom typing import ')
  })

  it('attaches the SDK declaration to a deferred tool\'s argument error inside a program', async () => {
    const { ctx, runtime } = await setup('ptc', { include: ['gbrain_put_page'] })
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
  })

  it('keeps a tool activated under native presentation listed by name in the SDK after the scope switches to PTC', async () => {
    const { ctx } = await setup('native', { include: ['gbrain_*', 'mcp__*'] })
    const session = Session.create(SessionId('switching-agent'))
    const agent = { id: session.id, session } as Agent
    let scoped!: Context
    await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, { inject: ['tools', 'systemPrompt'] }))
    expect(await wireNames(ctx, agent)).not.toContain('mcp__home__light_on')
    const result = await call(ctx, TOOL_SEARCH_NAME, { names: ['mcp__home__light_on'] }, agent)
    expect(text(result)).toContain('Declarations for mcp__home__light_on:\n[')
    expect(await wireNames(ctx, agent)).toContain('mcp__home__light_on')
    await scoped.plugin(PtcToolExecutor)
    const sdk = await sdkOf(ctx, agent)
    expect(sdk).toContain('- `mcp__home__light_on` — The mcp__home__light_on tool.')
    expect(sdk).not.toContain('  mcp__home__light_on: {')
  })

  it('shadows the deployment policy per scope', async () => {
    const { ctx } = await setup('ptc', { include: ['gbrain_*'] })
    const session = Session.create(SessionId('scoped'))
    const agent = { id: session.id, session } as Agent
    let scoped!: Context
    await ctx.plugin(Object.assign((inner: Context) => { scoped = createScope(inner, agent).ctx }, { inject: ['tools', 'systemPrompt'] }))
    const dispose = scoped.tools.deferAs({ include: ['bash'] })
    const sdk = await sdkOf(ctx, agent)
    expect(sdk).toContain('  gbrain_put_page: {')
    expect(sdk).toContain('- `bash` — The bash tool.')
    dispose()
    expect(await sdkOf(ctx, agent)).toContain('- `gbrain_put_page` — The gbrain_put_page tool.')
  })
})
