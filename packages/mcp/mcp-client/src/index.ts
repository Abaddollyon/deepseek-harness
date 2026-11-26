/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers. A
 * plugin that manages servers, such as the MCP manager, creates its own
 * `McpClientHost` to validate, mount, probe, and authorize them.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Transport } from '@modelcontextprotocol/client'
import z from '@deepseek-ai/schemastery'
import type { ReconnectConfig } from './connection.ts'
import { StdioSchema, StreamableHttpSchema } from './config.ts'
import type { ConfigInput } from './config.ts'
import { mount } from './mount.ts'
import type { McpOAuthConfig } from './oauth-options.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export { createMcpToolDefinition } from './tools.ts'
export { McpLocalError, McpToolError } from './diagnostic.ts'
export type { McpLocalErrorCode, McpToolErrorCode } from './diagnostic.ts'
export type { McpResult, McpToolDefinitionOptions } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'
export type { ConfigInput } from './config.ts'
export { McpClientHost } from './host.ts'
export type { McpServerInstance } from './host.ts'
export type { McpConnectionStatusHandle } from './status.ts'
export type * from './types.ts'
export type { McpOAuthAuthorization } from './oauth.ts'
export type { McpOAuthConfig, McpOAuthConfigInput } from './oauth-options.ts'
export type { McpProbeOptions } from './probe.ts'
export type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'

/**
 * Supply one connection generation's transport around its configured transport.
 * The generation still instruments the returned transport's `start`, `close`, and `onclose`.
 * @param open - create the configured stdio or Streamable HTTP transport; call it at most once.
 * @returns the transport this generation's MCP client connects through.
 */
export type TransportWrapper = (open: () => Transport) => Transport

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique among live mcp-client instances in the same registration scope.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Optional budget for one connection attempt plus its initial tool sync, in milliseconds. */
  startupTimeoutMs?: number
  /** Budget for transport closure and local cleanup, in milliseconds (default 5000). */
  closeTimeoutMs: number
  /** Resolve `${credential:…}` in transport strings at runtime and redact resolved values from diagnostics (default false). */
  expandTemplates: boolean
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
  /** `on-demand` lists the server's tools for agents to load instead of registering them (default `eager`). */
  toolLoading: 'eager' | 'on-demand'
  /** Maximum characters of each tool's summary in an on-demand server's prompt catalog (default 160). */
  catalogDescriptionMaxLength: number
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Optional per-entry OAuth identity; passive connections never start browser authorization. */
  oauth?: McpOAuthConfig
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique among live mcp-client instances in the same registration scope.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Optional budget for one connection attempt plus its initial tool sync, in milliseconds. */
  startupTimeoutMs?: number
  /** Budget for transport closure and local cleanup, in milliseconds (default 5000). */
  closeTimeoutMs: number
  /** Resolve `${credential:…}` in transport strings at runtime and redact resolved values from diagnostics (default false). */
  expandTemplates: boolean
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
  /** `on-demand` lists the server's tools for agents to load instead of registering them (default `eager`). */
  toolLoading: 'eager' | 'on-demand'
  /** Maximum characters of each tool's summary in an on-demand server's prompt catalog (default 160). */
  catalogDescriptionMaxLength: number
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

/** Validate one server's configuration and resolve its defaults. */
export const Config = z.union([StdioSchema, StreamableHttpSchema]) as z<ConfigInput, Config>

// ---- Plugin apply ----

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved transport and server namespace configuration.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await mount(ctx, config, undefined)
}
