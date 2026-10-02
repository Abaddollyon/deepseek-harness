/**
 * The reserved `tool_search` tool: looks up the declarations of tools a scope
 * defers, and in native presentation adds the found tools to that agent's
 * declared tools from its next step.
 * @module @deepseek-ai/dsh-tools/src/tool-search
 */

import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { defineTool } from './schema.ts'
import { searchTools, TOOL_SEARCH_LIMIT, TOOL_SEARCH_NAME } from './defer.ts'
import type { ToolDefinition, ToolRunContext } from './index.ts'
import type { ToolSdkSchema } from './ts-types.ts'

/** What `tool_search` needs from the registry that owns it. */
export interface ToolSearchOptions {
  /**
   * The tools the calling scope defers, with their SDK projections.
   * @param scope - the calling agent.
   * @returns every deferred visible tool, activated or not.
   */
  deferredTools(scope: ScopeKey | undefined): readonly ToolSdkSchema[]
  /**
   * Render declarations in the PTC runtime's SDK language.
   * @param schemas - the found tools.
   * @returns the fenced declaration text.
   */
  renderSdkDeclarations(schemas: readonly ToolSdkSchema[]): string
  /**
   * Add tools to the calling agent's declared tools from its next step.
   * @param scope - the calling agent.
   * @param names - the found deferred tools.
   */
  activate(scope: ScopeKey, names: readonly string[]): void
}

/** The `tool_search` result value. */
interface ToolSearchOutput {
  /** Tools whose declarations follow, in the order selected. */
  tools: string[]
  /** Requested names that are not deferred tools of this agent. */
  unknown: string[]
  /** The found tools' declarations. */
  declarations: string
}

const DESCRIPTION = 'Look up the declarations of tools listed by name only under "More tools". '
  + 'Pass exact `names`, or a keyword `query` matched against tool names and descriptions; '
  + `at most ${String(TOOL_SEARCH_LIMIT)} tools are returned.`

/** Render the native result: the declarations as JSON tool schemas. */
function nativeDeclarations(schemas: readonly ToolSdkSchema[]): string {
  return JSON.stringify(schemas.map(({ name, description, parameters }) => ({ name, description, parameters })), null, 2)
}

/**
 * Build the reserved `tool_search` definition.
 * @param options - the owning registry's lookups.
 * @returns the tool definition.
 */
export function createToolSearchTool(options: ToolSearchOptions): ToolDefinition {
  return defineTool({
    name: TOOL_SEARCH_NAME,
    description: DESCRIPTION,
    parameters: {
      names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names to look up.' },
      query: { type: 'string', description: 'Keywords that every returned tool name or description contains.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tools: { type: 'array', required: true, items: { type: 'string' } },
          unknown: { type: 'array', required: true, items: { type: 'string' } },
          declarations: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines: string[] = []
        if (value.tools.length === 0) lines.push('No deferred tool matched.')
        else lines.push(`Declarations for ${value.tools.join(', ')}:`, value.declarations)
        if (value.unknown.length > 0) lines.push(`Not deferred tools of this agent: ${value.unknown.join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args, exec: ToolRunContext): Promise<ToolSearchOutput> {
      if ((args.names === undefined || args.names.length === 0) && (args.query === undefined || args.query.trim().length === 0)) {
        return Promise.reject(new Error('tool_search needs `names` or a non-empty `query`'))
      }
      const { found, unknown } = searchTools(options.deferredTools(exec.agent), args.names, args.query)
      // A program inside run_code reads the SDK's own format; a direct call
      // reads JSON schemas, and those tools join the agent's declared tools.
      const nested = exec.parent !== undefined
      if (!nested && exec.agent !== undefined && found.length > 0) {
        options.activate(exec.agent, found.map(schema => schema.name))
      }
      const declarations = found.length === 0 ? '' : nested ? options.renderSdkDeclarations(found) : nativeDeclarations(found)
      return Promise.resolve({ tools: found.map(schema => schema.name), unknown, declarations })
    },
  })
}
