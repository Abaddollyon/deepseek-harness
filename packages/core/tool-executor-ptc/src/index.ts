/** PTC execution plugin for the mounting Agent, preset, or deployment scope. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import { RUN_CODE_NAME, ToolNotFoundError, projectToolSchema } from '@deepseek-ai/dsh-tools'
import type {
  DeferredToolEntry, ToolDefinition, ToolDeferral, ToolExecutor, ToolModelInput, ToolPromptSection, ToolBatchInput, ToolBatchResult,
} from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import { createRunCodeTool, requirePtcRuntime, type PtcSdkLanguage } from './ptc.ts'
import { renderToolDeclarations, renderToolsSdk, type ToolSdkSchema } from './ts-types.ts'
import { renderToolDeclarationsPy, renderToolsSdkPy } from './py-types.ts'
import { Config } from './config.ts'

const PTC_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`

type SdkRenderer = (schemas: readonly ToolSdkSchema[], programFormat: PtcProgramFormat, deferred: readonly DeferredToolEntry[]) => string

const SDK_RENDERERS = {
  typescript: renderToolsSdk,
  // The Python SDK has one program format.
  python: (schemas, _programFormat, deferred) => renderToolsSdkPy(schemas, deferred),
} satisfies Record<PtcSdkLanguage, SdkRenderer>

/** Per-language renderers of the declaration fragments `tool_search` returns inside a program. */
const DECLARATION_RENDERERS = {
  typescript: renderToolDeclarations,
  python: renderToolDeclarationsPy,
} satisfies Record<PtcSdkLanguage, (schemas: readonly ToolSdkSchema[]) => string>

/**
 * Project definitions onto the SDK contract: the model-facing schema plus the canonical output schema.
 * @param tools - the definitions to declare.
 * @returns one SDK schema per definition.
 */
function sdkSchemas(tools: readonly ToolDefinition[]): ToolSdkSchema[] {
  return tools.map(definition => ({
    ...projectToolSchema(definition, false),
    output: definition.output.schema,
  }))
}

/** Runs programs whose nested tool calls use the shared guarded invocation pipeline. */
export class PtcExecutor implements ToolExecutor {
  readonly sections: readonly ToolPromptSection[]
  private readonly pipeline: ToolExecutionPipeline
  private readonly maxParallelSubCalls: number
  private ptcTransport: ToolDefinition | undefined

  constructor(private readonly ctx: Context, config: Partial<Config> = {}, private readonly maxParallel: () => number = () => 10) {
    this.maxParallelSubCalls = Config(config).maxParallelSubCalls
    const tools = ctx.tools
    this.sections = [
      { name: 'tools:ptc-only', order: ctx.systemPrompt.getSectionOrder('PTC_ONLY'), text: PTC_ONLY_INSTRUCTION, interpolate: false },
      { name: 'tools:sdk', order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'), text: (tools, deferral) => this.renderSdk(tools, deferral), interpolate: false },
    ]
    this.pipeline = new ToolExecutionPipeline(ctx, {
      get: (name, scope, toolSet) => name === RUN_CODE_NAME ? this.requirePtcTransport() : tools.executable(name, scope, toolSet),
      reject: (name, nested) => !nested && name !== RUN_CODE_NAME
        ? new ToolNotFoundError(name, `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`)
        : undefined,
    })
  }

  describe(_tools: readonly ToolDefinition[]): ToolModelInput {
    return { schemas: [projectToolSchema(this.requirePtcTransport(), false)], knownNames: [RUN_CODE_NAME] }
  }

  /**
   * Render the SDK: declarations for every tool the scope does not defer, and
   * a name-only index of the deferrable ones. It reads the activation-independent
   * deferrable set, so a direct `tool_search` activation while the scope
   * presented natively leaves this section unchanged.
   */
  private renderSdk(tools: readonly ToolDefinition[], deferral: ToolDeferral): string {
    const runtime = requirePtcRuntime(this.ctx)
    const render: SdkRenderer = SDK_RENDERERS[runtime.language]
    const declared = tools.filter(definition => !deferral.deferrable.has(definition.name))
    const deferred = tools.filter(definition => deferral.deferrable.has(definition.name))
    return render(sdkSchemas(declared), runtime.programFormat, deferred)
  }

  programDeclarations(tools: readonly ToolDefinition[]): string {
    return DECLARATION_RENDERERS[requirePtcRuntime(this.ctx).language](sdkSchemas(tools))
  }

  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return executeToolBatch(input, this.pipeline, this.maxParallel)
  }

  /** Keep the reserved transport outside registered capabilities and their restrictions. */
  private requirePtcTransport(): ToolDefinition {
    this.ptcTransport ??= createRunCodeTool(this.ctx, this.pipeline, this.maxParallelSubCalls)
    return this.ptcTransport
  }
}

export { Config } from './config.ts'
export { CodeRunFailedError } from './errors.ts'
export type { PtcDispatchLog } from './runtime-types.ts'
export type { PtcDispatchStartEventData, PtcDispatchEventData } from './types.ts'
export { jsonSchemaToTs, renderToolsSdk, type ToolSdkSchema } from './ts-types.ts'
export { jsonSchemaToPy, renderToolsSdkPy } from './py-types.ts'

/** Cordis plugin name. */
export const name = 'ptc-tool-executor'
/** Activate the executor only while its registry, prompt service, and runtime are available. */
export const inject = ['tools', 'systemPrompt', 'ptcRuntime']

/**
 * Select PTC execution in the mounting scope.
 * @param ctx - context owning this executor's selection and lifetime.
 * @param config - program subcall concurrency limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.setExecutor(new PtcExecutor(ctx, config))
}
