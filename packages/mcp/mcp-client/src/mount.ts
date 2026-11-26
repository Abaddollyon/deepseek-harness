/**
 * Shared plugin body for the mcp-client entry's `apply` and the
 * `@deepseek-ai/dsh-mcp-client/transport-wrapper` plugin object.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { resolveReconnectPolicy, startConnection } from './connection.ts'
import { hasOAuthWithAuthorizationHeader } from './config.ts'
import { registerServerContext } from './server-context.ts'
import { registerStatusCell } from './status.ts'
import { McpOAuthCredentials } from './oauth-credentials.ts'
import type { Config, TransportWrapper } from './index.ts'

/**
 * Live `serverName` reservations per registration scope. Agent-scoped MCP
 * servers may reuse a namespace in another Agent, while global instances and
 * duplicates inside one Agent remain mutually exclusive.
 */
const activeServerNames = new WeakMap<object, Set<string>>()

/**
 * Connect one MCP server for the plugin entry's `apply` or a transport-wrapped plugin object.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved transport and server namespace configuration.
 * @param wrap - optional caller-owned wrapper around each generation's configured transport.
 * @returns startup readiness after connection and initial tool discovery settle.
 */
export async function mount(ctx: Context, config: Config, wrap: TransportWrapper | undefined): Promise<void> {
  if (hasOAuthWithAuthorizationHeader(config)) {
    throw new Error('MCP OAuth and an Authorization header cannot be configured together')
  }
  const oauth = config.transport === 'streamable-http' && config.oauth !== undefined
    ? new McpOAuthCredentials(ctx, config.oauth)
    : undefined
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)

  // Namespace reservations are scope-local; status belongs to the actual
  // Fiber and survives its reloads and final disposal.
  let status!: ReturnType<typeof registerStatusCell>
  ctx.effect(() => {
    const owner = scopeOf(ctx) ?? ctx[Context.root]
    let names = activeServerNames.get(owner)
    if (!names) {
      names = new Set()
      activeServerNames.set(owner, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    status = registerStatusCell(ctx.fiber, (message, error) => {
      ctx.logger.warn(`mcp-client(${config.serverName}): ${message}`)
      if (!config.expandTemplates && !(config.transport === 'streamable-http' && config.oauth !== undefined)) ctx.logger.warn(error)
    })
    return () => {
      if (ctx.fiber.uid === null) status.detach()
      names.delete(config.serverName)
    }
  }, 'mcp-client.serverName')

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  if (!status.closure().closeConfirmed || status.closure().cleanupError !== undefined) {
    throw new Error(`mcp-client(${config.serverName}): previous connection cleanup is incomplete; restart the Host`)
  }
  const connection = startConnection(ctx, config, reconnect, status, oauth, wrap)
  let stopping: Promise<void> | undefined
  const dispose = (): Promise<void> => stopping ??= connection.dispose()
  // Cordis announces unload before awaiting an unfinished apply(). Closing
  // the transport here releases startup requests that are still awaiting a reply.
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis contains observer failures; the effect also awaits this promise.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber !== ctx.fiber || fiber.uid !== null) return
    return dispose()
  }, { global: true })
  ctx.effect(() => dispose, 'mcp-client.connection')
  registerServerContext(ctx, config.serverName, connection)

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor applies its reconnect or credential-wait policy.
  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
