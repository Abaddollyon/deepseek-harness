/**
 * The reserved `tool_search` tool: looks up the declarations of tools a scope
 * defers, and for a direct call adds the found tools to that agent's
 * declared tools from its next step.
 * @module @deepseek-ai/dsh-tools/src/tool-search
 */

import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { defineTool } from './schema.ts'
import { searchTools, TOOL_SEARCH_LIMIT, TOOL_SEARCH_NAME } from './defer.ts'
import type { ToolDefinition, ToolRunContext } from './contracts.ts'

/** What `tool_search` needs from the registry that owns it. */
export interface ToolSearchOptions {
  /**
   * The tools the calling scope defers for this call's step.
   * @param exec - the `tool_search` call: its agent and step admission.
   * @returns every deferred visible tool, activated or not.
   */
  deferredTools(exec: ToolRunContext): readonly ToolDefinition[]
  /**
   * Render the found tools' declarations for the caller: a program reads its
   * executor's SDK format, a direct call JSON schemas.
   * @param tools - the found tools.
   * @param exec - the `tool_search` call.
   * @returns the declaration text.
   */
  renderDeclarations(tools: readonly ToolDefinition[], exec: ToolRunContext): string
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
      const { found, unknown } = searchTools(options.deferredTools(exec), args.names, args.query)
      // A program reads its SDK's own format; only a direct call adds the
      // found tools to the agent's declared tools.
      if (exec.parent === undefined && exec.agent !== undefined && found.length > 0) {
        options.activate(exec.agent, found.map(tool => tool.name))
      }
      const declarations = found.length === 0 ? '' : options.renderDeclarations(found, exec)
      return Promise.resolve({ tools: found.map(tool => tool.name), unknown, declarations })
    },
  })
}
