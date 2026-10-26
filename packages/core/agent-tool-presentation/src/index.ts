/**
 * Declare which tools every Agent in the mounting scope sees by name only,
 * and select built-in tool execution for them (deprecated: mount
 * @deepseek-ai/dsh-tool-executor-native or @deepseek-ai/dsh-tool-executor-ptc
 * directly).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDeferConfig } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'

/** Cordis plugin name. */
export const name = 'tool-presentation'

/**
 * Native selection does not require a program runtime; the PTC child waits
 * for its runtime before registering an executor in this scope.
 */
export const inject = ['tools']

/** Plugin config. At least one field is required: a row with neither changes nothing. */
export interface Config {
  /**
   * The form this agent's model sees. `native` sends every visible schema,
   * `ptc` sends only `run_code` plus a generated SDK. Omitted keeps the
   * inherited executor. Compatibility only: new compositions mount the native
   * or PTC executor plugin directly.
   */
  mode?: 'native' | 'ptc'
  /**
   * Tools this agent's model sees by name only, with `*` name patterns; the
   * model fetches a declaration with `tool_search`. Omitted keeps the
   * deployment default policy.
   */
  defer?: ToolDeferConfig | undefined
}

/** Runtime schema. */
export const Config: z<Config> = z.object({
  mode: z.union(['native', 'ptc'] as const),
  // Absent stays absent: an empty policy would shadow the deployment default.
  defer: z.union([z.const(undefined), z.object({
    include: z.array(z.string().min(1)),
    exclude: z.array(z.string().min(1)),
  })]),
})

/**
 * Declare the defer policy and tool execution for every agent this composition covers.
 * @param ctx - the mounting composition's scope context (a preset's standing scope).
 * @param config - the defer policy and the selected execution.
 */
export function apply(ctx: Context, config: Config): void {
  const mode = config.mode
  if (mode === undefined && config.defer === undefined) {
    throw new Error('tool-presentation: set `mode`, `defer`, or both; a row with neither changes nothing')
  }
  // `deferAs` is itself the effect — it registers through the calling context
  // and hands back that exact disposer — so the declaration unwinds with this row.
  if (config.defer !== undefined) ctx.tools.deferAs(config.defer)
  if (mode !== undefined) ctx.plugin(mode === 'native' ? NativeToolExecutor : PtcToolExecutor)
}
