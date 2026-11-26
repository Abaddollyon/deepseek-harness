/**
 * Transport-wrapped mcp-client plugin objects, kept off the plugin entry so
 * the Loader's module namespace stays the four plugin exports.
 *
 * @module @deepseek-ai/dsh-mcp-client/transport-wrapper
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, inject, name } from './index.ts'
import type { TransportWrapper } from './index.ts'
import { mount } from './mount.ts'

/**
 * Build an mcp-client plugin whose connection generations connect through `wrap`.
 * It accepts the same {@link Config} and keeps the namespace, status, startup, tool, and disposal behavior of the plugin module.
 * @param wrap - caller-owned wrapper around each generation's configured transport.
 * @returns a plugin object mounted with `ctx.plugin(plugin, config)`.
 */
export function withTransportWrapper(wrap: TransportWrapper): {
  name: typeof name
  inject: typeof inject
  Config: typeof Config
  apply: (ctx: Context, config: Config) => Promise<void>
} {
  return { name, inject, Config, apply: (ctx: Context, config: Config) => mount(ctx, config, wrap) }
}
