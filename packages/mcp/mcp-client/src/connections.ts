/**
 * Host connection owner (`ctx.nativeMcpConnections`): the Host side of
 * host-managed MCP connections. It owns the settings-backed nonsecret
 * connection configs, one OAuth protocol engine per connection, the
 * authorization flow registrations that let a human sign a connection in, and
 * the bindings agent-side mcp-client instances consume.
 *
 * The service never stores tokens itself: grants live in native credential
 * records under `mcp-connections/<connectionId>`, written only through
 * `ctx.credentials.modifyRecord` by the protocol engine (`src/oauth.ts`).
 * The default engine factory constructs that engine; deployments and tests
 * can substitute their own through the constructor internals.
 *
 * Mount once in the Host composition (`ctx.plugin(NativeMcpConnectionsService)`).
 * Agents never receive URL, headers, or tokens: a binding hands the
 * supervisor a ready transport whose every request is authenticated by the
 * Host-owned engine fetch. Status views are token-free facts.
 *
 * @module
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialKey, credentialKeyId, credentialKeyScope, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
// Side-effect type import: declaration-merges `ctx.settings` onto Context.
import type {} from '@deepseek-ai/dsh-settings'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { errorToken } from './connection.ts'
import type { ConnectionInvalidation, ConnectionSource } from './connection.ts'
import { McpOAuthConnection } from './oauth.ts'
import type { McpOAuthChange, McpOAuthRevocation, McpOAuthStatus } from './oauth.ts'

export type { McpOAuthChange, McpOAuthRevocation } from './oauth.ts'

/** Settings namespace holding every host-managed MCP connection (nonsecret). */
export const SETTINGS_NS = 'mcp-connections'

/** Credential record scope addressing this service's grant records. */
const RECORD_SCOPE = 'mcp-connections'

/** Service name on `ctx`, consumed agent-side through `ctx.get`. */
const SERVICE_NAME = 'nativeMcpConnections'

/** Schema defaults, overridable per connection in the settings document. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RESPONSE_BYTE_LIMIT = 1_048_576
const DEFAULT_REFRESH_LEEWAY_MS = 30_000

/** Product identity sent with dynamic client registration (not a tunable). */
const DEFAULT_CLIENT_NAME = 'DeepSeek Harness MCP client'

// ---- Settings schema ----

/**
 * One host-managed MCP connection as the settings document stores it. Every
 * field is nonsecret: the endpoint and the OAuth client parameters the
 * protocol engine needs. Grants never appear here.
 */
export interface McpConnectionEntry {
  /** User-facing name for pickers; defaults to the connection id. */
  label?: string
  /** MCP endpoint URL; HTTPS without userinfo (validate enforces). */
  url: string
  /** Expected OAuth issuer URL; HTTPS. */
  issuerUrl: string
  /** Protected-resource URL; defaults to the MCP endpoint when absent. */
  resourceUrl?: string
  /** Completion page the human pastes the callback URL from; HTTPS. */
  redirectUri: string
  /** OAuth scopes to request; empty lets the server choose. */
  scopes: string[]
  /** Pre-registered public client id; omission lets the engine register dynamically (RFC 7591). */
  clientId?: string
  /** Client name sent with dynamic registration. */
  clientName: string
  /** Wall-clock bound for each OAuth protocol request including its body, in milliseconds. */
  requestTimeoutMs: number
  /** Byte ceiling on each OAuth protocol response body. */
  responseByteLimit: number
  /** Refresh this long before the access token's advertised expiry, in milliseconds. */
  refreshLeewayMs: number
}

type McpConnectionEntryInput = Omit<McpConnectionEntry, 'scopes' | 'clientName' | 'requestTimeoutMs' | 'responseByteLimit' | 'refreshLeewayMs'>
  & Partial<Pick<McpConnectionEntry, 'scopes' | 'clientName' | 'requestTimeoutMs' | 'responseByteLimit' | 'refreshLeewayMs'>>

/** Resolved value of the `mcp-connections` settings namespace, keyed by connection id. */
export type McpConnectionsSettings = Record<string, McpConnectionEntry>
type McpConnectionsSettingsInput = Record<string, McpConnectionEntryInput>

const Entry = z.object({
  label: z.string(),
  url: z.string().required(),
  issuerUrl: z.string().required(),
  resourceUrl: z.string(),
  redirectUri: z.string().required(),
  scopes: z.array(String).default([]),
  clientId: z.string(),
  clientName: z.string().default(DEFAULT_CLIENT_NAME),
  requestTimeoutMs: z.number().min(1).default(DEFAULT_REQUEST_TIMEOUT_MS),
  responseByteLimit: z.number().min(1).default(DEFAULT_RESPONSE_BYTE_LIMIT),
  refreshLeewayMs: z.number().min(1).default(DEFAULT_REFRESH_LEEWAY_MS),
})

const SettingsSchema = z.dict(Entry).default({}) as unknown as z<McpConnectionsSettingsInput, McpConnectionsSettings>

/** Parse an HTTPS URL without userinfo, rejecting anything else at the settings write. */
function httpsUrl(value: string, path: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${path} must be an absolute URL`)
  }
  if (url.protocol !== 'https:') throw new TypeError(`${path} must be an HTTPS URL`)
  if (url.username !== '' || url.password !== '') throw new TypeError(`${path} must not embed userinfo`)
  return url
}

/**
 * Refuse an unserviceable connections section where it is written. The schema
 * cannot express URL grammar, userinfo rejection, or the connection-id
 * grammar the credential record keys depend on, so those live here.
 * @param value - the resolved connections section, schema-valid by construction.
 */
function validateConnections(value: McpConnectionsSettings): void {
  for (const [id, entry] of Object.entries(value)) {
    if (!isCredentialKeySegment(id)) {
      throw new TypeError(`mcp-connections key "${id}" must match /^[a-z][a-z0-9-]*$/ (it addresses the grant record mcp-connections/${id})`)
    }
    httpsUrl(entry.url, `mcp-connections.${id}.url`)
    httpsUrl(entry.issuerUrl, `mcp-connections.${id}.issuerUrl`)
    if (entry.resourceUrl !== undefined) httpsUrl(entry.resourceUrl, `mcp-connections.${id}.resourceUrl`)
    httpsUrl(entry.redirectUri, `mcp-connections.${id}.redirectUri`)
  }
}

// ---- Engine seam ----

/** Token-free engine lifecycle facts; the UI vocabulary the Host may repeat. */
export type McpConnectionEngineStatus = McpOAuthStatus

/**
 * The protocol engine surface the Host bridge relies on. One instance per
 * connection, owned by this service. All token movement — refresh included —
 * stays inside the engine's own serialized operation queue; the bridge never
 * reads grant payloads.
 */
export interface McpConnectionEngine {
  /**
   * Token-free lifecycle facts for status views.
   * @returns the current authorization state, in-flight operation, grant facts, and record epoch.
   */
  status(): Promise<McpConnectionEngineStatus>
  /**
   * Run one interactive authorization attempt through the native
   * authorization session (notices carry the sign-in URL; the callback URL
   * comes back through a `secret` prompt). Commits the grant through
   * `ctx.credentials.modifyRecord` before resolving.
   * @param session - the attempt the AuthorizationService is running.
   */
  authorize(session: AuthorizationSession): Promise<void>
  /**
   * The Host-owned fetch for this connection's MCP endpoint: attaches the
   * current bearer token, accepts only the configured endpoint, rejects
   * caller-supplied credential headers, disables redirects, and answers 401
   * with one shared forced refresh plus one retry before invalidating. MCP
   * bodies and SSE stay streaming.
   * @param signal - aborted when the owning generation is superseded.
   * @returns the fetch the Streamable HTTP transport issues every request through.
   */
  authenticatedFetch(signal: AbortSignal): FetchLike
  /**
   * Local-first revocation: the local tombstone is committed before any bounded remote attempt.
   * @returns the local outcome and the bounded remote outcome.
   */
  revoke(): Promise<McpOAuthRevocation>
  /** Abort owned work and await quiescence. */
  dispose(): Promise<void>
}

/** Inputs the service hands the engine factory for one connection. */
export interface McpConnectionEngineInit {
  /** Host context, for the credential seam and logger. */
  ctx: Context
  /** The grant record this engine alone writes. */
  credentialKey: CredentialKey
  /** Frozen connection identity and network bounds from settings. */
  spec: ResolvedMcpConnectionSpec
  /**
   * Observer of the durable transitions the engine commits; the service maps
   * them to consumer invalidations. The engine contains observer failures.
   * @param change - the committed transition.
   */
  onChange: (change: McpOAuthChange) => void
}

/**
 * Construct the protocol engine for one connection. Injectable so tests
 * substitute engines without touching OAuth; production uses the default.
 */
export type McpConnectionEngineFactory = (init: McpConnectionEngineInit) => McpConnectionEngine

/** The production engine: `src/oauth.ts` over this Host's credential seam, with the service observing its transitions. */
function defaultEngineFactory(init: McpConnectionEngineInit): McpConnectionEngine {
  return new McpOAuthConnection(init.ctx.credentials, {
    key: init.credentialKey,
    serverUrl: init.spec.url,
    expectedIssuerUrl: init.spec.issuerUrl,
    resourceUrl: init.spec.resourceUrl,
    redirectUri: init.spec.redirectUri,
    scopes: init.spec.scopes,
    ...init.spec.clientId === undefined ? {} : { clientId: init.spec.clientId },
    clientName: init.spec.clientName,
    requestTimeoutMs: init.spec.requestTimeoutMs,
    responseByteLimit: init.spec.responseByteLimit,
    refreshLeewayMs: init.spec.refreshLeewayMs,
  }, { onChange: init.onChange })
}

// ---- Resolved spec ----

/** Frozen connection identity and bounds handed to the engine and transport. */
export interface ResolvedMcpConnectionSpec {
  /** MCP endpoint URL (HTTPS, userinfo-free). */
  url: string
  /** Expected OAuth issuer URL. */
  issuerUrl: string
  /** Protected-resource URL (defaults resolved: the MCP endpoint itself). */
  resourceUrl: string
  /** Callback completion page. */
  redirectUri: string
  /** OAuth scopes to request. */
  scopes: readonly string[]
  /** Pre-registered public client id, when configured. */
  clientId?: string
  /** Client name sent with dynamic registration. */
  clientName: string
  /** Wall-clock bound for each OAuth protocol request including its body, in milliseconds. */
  requestTimeoutMs: number
  /** Byte ceiling on each OAuth protocol response body. */
  responseByteLimit: number
  /** Refresh this long before the access token's advertised expiry, in milliseconds. */
  refreshLeewayMs: number
  /**
   * Per-service-instance monotonic generation of this connection's
   * configuration, bumped on every spec change so the engine can fence grant
   * reuse across config generations instead of silently reusing an old grant.
   */
  configGeneration: number
}

/**
 * The one explicit resolve step from a settings entry to the spec the engine
 * and transport run. Defaults materialize here, never inside consumers.
 * @param entry - the settings entry, schema-valid and validate()-approved.
 * @param configGeneration - the connection's current config generation.
 * @returns the frozen spec.
 */
export function resolveSpec(entry: McpConnectionEntry, configGeneration: number): ResolvedMcpConnectionSpec {
  return Object.freeze({
    url: entry.url,
    issuerUrl: entry.issuerUrl,
    resourceUrl: entry.resourceUrl ?? entry.url,
    redirectUri: entry.redirectUri,
    scopes: Object.freeze([...entry.scopes]),
    ...entry.clientId === undefined ? {} : { clientId: entry.clientId },
    clientName: entry.clientName,
    requestTimeoutMs: entry.requestTimeoutMs,
    responseByteLimit: entry.responseByteLimit,
    refreshLeewayMs: entry.refreshLeewayMs,
    configGeneration,
  })
}

/** Fingerprint for change detection; configGeneration is deliberately excluded. */
function specFingerprint(spec: ResolvedMcpConnectionSpec, label: string): string {
  return JSON.stringify({
    url: spec.url,
    issuerUrl: spec.issuerUrl,
    resourceUrl: spec.resourceUrl,
    redirectUri: spec.redirectUri,
    scopes: spec.scopes,
    clientId: spec.clientId,
    clientName: spec.clientName,
    requestTimeoutMs: spec.requestTimeoutMs,
    responseByteLimit: spec.responseByteLimit,
    refreshLeewayMs: spec.refreshLeewayMs,
    label,
  })
}

// ---- Status views ----

/**
 * Token-free facts about one connection for configuration UIs. `state` is
 * the engine's authorization lifecycle (or `unavailable` while no engine
 * could be constructed); it says nothing about tool discoverability, which
 * only the consuming agent's supervisor knows.
 */
export interface McpConnectionStatusView {
  /** The settings key addressing this connection. */
  id: string
  /** User-facing name. */
  label: string
  /** MCP endpoint URL (validated userinfo-free). */
  url: string
  /** Whether the connection is declared in settings. */
  configured: boolean
  /** Authorization lifecycle state. */
  state: McpConnectionEngineStatus['state'] | 'unavailable'
  /** Whether an authorization attempt is running for this connection's flow. */
  inFlightAuth: boolean
  /** `serverName`s of the agent-side instances currently bound. */
  consumers: string[]
  /** Invalidation counter consumers compare against their supervisor state. */
  epoch: number
}

// ---- Binding ----

/**
 * One agent-side consumer's handle on a host connection: the
 * {@link ConnectionSource} the mcp-client supervisor runs, plus the release
 * that unregisters the consumer.
 */
export interface McpConnectionBinding extends ConnectionSource {
  /** Authority epoch of the connection; bumped on every invalidation. */
  readonly epoch: number
  /** Unregister this consumer; idempotent. */
  release(): void
}

/** Live per-connection state owned by the service. */
interface ConnectionState {
  readonly id: string
  readonly credentialKey: CredentialKey
  entry: McpConnectionEntry
  spec: ResolvedMcpConnectionSpec
  engine: McpConnectionEngine | undefined
  flowDispose: (() => void) | undefined
  readonly listeners: Set<(reason: ConnectionInvalidation) => void>
  readonly consumers: Map<McpConnectionBinding, string>
  /** Granted scope the last engine status reported; a refresh that changes it invalidates consumers. */
  grantedScope: string | undefined
  epoch: number
}

/** Replaceable seams for direct unit tests. */
export interface NativeMcpConnectionsInternals {
  /** Engine construction override; tests substitute OAuth-free engines. */
  readonly engineFactory?: McpConnectionEngineFactory
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of host-managed MCP connections. */
    nativeMcpConnections: NativeMcpConnectionsService
  }
}

/**
 * `ctx.nativeMcpConnections`: the Host connection owner. Settings changes
 * reconcile engines, flows, and bindings live; credential and authorization
 * events invalidate consumers immediately; a revoked or removed connection
 * hands no transport and cannot resurrect without a new authority signal.
 */
export class NativeMcpConnectionsService extends Service {
  /** The grant store, the config document, and the flow registry are all required. */
  static inject = ['credentials', 'settings', 'authorization']

  private readonly engineFactory: McpConnectionEngineFactory
  private readonly connections = new Map<string, ConnectionState>()
  private readonly configGenerations = new Map<string, number>()

  /**
   * Register the settings namespace, reconcile the stored document, and wire
   * credential/authorization observation. Every registration is an effect on
   * the service fiber, so disposal unwinds flows, watchers, and engines.
   * @param ctx - Host context carrying the credentials, settings, and authorization services.
   * @param internals - replaceable engine factory for direct unit tests.
   */
  constructor(ctx: Context, internals: NativeMcpConnectionsInternals = {}) {
    super(ctx, SERVICE_NAME)
    this.engineFactory = internals.engineFactory ?? defaultEngineFactory
    const scope = ctx.settings.register(SETTINGS_NS, SettingsSchema, {
      applies: 'live',
      validate: validateConnections,
    })
    scope.watch(async (next) => { await this.reconcile(next) })
    this.reconcileNow(scope.get())
    ctx.on('credentials/record-updated', (key) => {
      if (credentialKeyScope(key) === RECORD_SCOPE) this.invalidate(credentialKeyId(key), 'stale')
    })
    ctx.on('authorization/settled', (key, settlement) => {
      if (credentialKeyScope(key) === RECORD_SCOPE && settlement === 'authorized') {
        this.invalidate(credentialKeyId(key), 'reauthorized')
      }
    })
    ctx.effect(() => () => this.disposeEngines(), 'mcp-connections.engines')
  }

  /**
   * Bind one agent-side consumer to a configured connection.
   * @param id - the settings key of the connection to consume.
   * @param consumer - the consumer's public tool namespace, for status bookkeeping.
   * @returns the binding the mcp-client supervisor runs as its connection source.
   * @throws when no connection with this id is configured.
   */
  acquire(id: string, consumer: { serverName: string }): McpConnectionBinding {
    const connection = this.connections.get(id)
    if (connection === undefined) {
      throw new Error(`mcp-connections: unknown connection "${id}" — declare it under the "${SETTINGS_NS}" settings namespace`)
    }
    const listeners = new Set<(reason: ConnectionInvalidation) => void>()
    const binding: McpConnectionBinding = {
      get epoch() { return connection.epoch },
      connect: signal => this.connectTransport(connection, signal),
      onInvalidate: (listener) => {
        listeners.add(listener)
        connection.listeners.add(listener)
        return () => {
          listeners.delete(listener)
          connection.listeners.delete(listener)
        }
      },
      release: () => {
        for (const listener of listeners) connection.listeners.delete(listener)
        listeners.clear()
        connection.consumers.delete(binding)
      },
    }
    connection.consumers.set(binding, consumer.serverName)
    return binding
  }

  /**
   * Token-free facts about one configured connection.
   * @param id - the connection to describe.
   * @returns the status view, or undefined when no such connection is configured.
   */
  async describe(id: string): Promise<McpConnectionStatusView | undefined> {
    const connection = this.connections.get(id)
    if (connection === undefined) return undefined
    return this.view(connection)
  }

  /**
   * Token-free facts about every configured connection, in settings order.
   * @returns one status view per connection.
   */
  async list(): Promise<McpConnectionStatusView[]> {
    return Promise.all([...this.connections.values()].map(connection => this.view(connection)))
  }

  /**
   * The grant record key a surface needs to drive this connection's
   * authorization flow through `ctx.authorization`.
   * @param id - the connection whose flow key is asked.
   * @returns the credential record key.
   */
  recordKeyFor(id: string): CredentialKey {
    if (!isCredentialKeySegment(id)) {
      throw new TypeError(`mcp-connections id "${id}" must match /^[a-z][a-z0-9-]*$/`)
    }
    return credentialKey(RECORD_SCOPE, id)
  }

  /**
   * Revoke one connection's grant: the engine commits the local tombstone
   * first and its `revoked` transition invalidates every consumer, so the
   * withdrawal takes effect immediately.
   * @param id - the connection to revoke.
   * @returns the local outcome and the bounded remote outcome.
   */
  async revoke(id: string): Promise<McpOAuthRevocation> {
    const connection = this.connection(id)
    if (connection.engine === undefined) {
      throw new Error(`mcp-connections: connection "${id}" has no live protocol engine`)
    }
    return connection.engine.revoke()
  }

  /**
   * Delete one connection's grant record outright (the "forget" operation).
   * The record-updated event invalidates consumers on its own.
   * @param id - the connection whose grant is removed.
   */
  async removeGrant(id: string): Promise<void> {
    await this.ctx.credentials.deleteRecord(this.recordKeyFor(id))
  }

  /** The connection or a loud unknown-id error naming the fix. */
  private connection(id: string): ConnectionState {
    const connection = this.connections.get(id)
    if (connection === undefined) {
      throw new Error(`mcp-connections: unknown connection "${id}" — declare it under the "${SETTINGS_NS}" settings namespace`)
    }
    return connection
  }

  /**
   * Build the transport for one consumer generation. The URL and the
   * engine-owned authenticating fetch are the whole configuration: no
   * `authProvider`, so the SDK transport can neither spend tokens through
   * its own refresh path nor begin interactive authorization. Returns
   * undefined while the authority holds the connection down.
   */
  private async connectTransport(connection: ConnectionState, signal: AbortSignal): Promise<Transport | undefined> {
    const engine = connection.engine
    if (engine === undefined || signal.aborted) return undefined
    const status = await engine.status()
    if (status.state !== 'authorized' || signal.aborted) return undefined
    // The MCP SDK's StreamableHTTPClientTransport has optional properties typed
    // without `| undefined` (exactOptionalPropertyTypes mismatch with the
    // Transport interface); the SDK constructed the object, so the cast
    // records only that widening.
    return new StreamableHTTPClientTransport(
      new URL(connection.spec.url),
      { fetch: engine.authenticatedFetch(signal) },
    ) as Transport
  }

  /** Token-free view of one connection; every field is a fact the Host owns. */
  private async view(connection: ConnectionState): Promise<McpConnectionStatusView> {
    const status = connection.engine === undefined ? undefined : await connection.engine.status()
    return {
      id: connection.id,
      label: connection.entry.label ?? connection.id,
      url: connection.spec.url,
      configured: true,
      state: status?.state ?? 'unavailable',
      inFlightAuth: this.ctx.authorization.describe(connection.credentialKey)?.inFlight ?? false,
      consumers: [...connection.consumers.values()],
      epoch: connection.epoch,
    }
  }

  /**
   * Map one committed engine transition to the consumer invalidation it
   * means. A refresh is usually invisible to consumers — but one whose
   * granted scope changed supersedes the grant consumers connected with, so
   * their cached tool registrations must re-established against it.
   */
  private onEngineChange(id: string, change: McpOAuthChange): void {
    switch (change) {
      case 'authorized':
        this.invalidate(id, 'reauthorized')
        return
      case 'refreshed': {
        const connection = this.connections.get(id)
        if (connection?.engine === undefined) return
        void connection.engine.status().then((status) => {
          const current = this.connections.get(id)
          if (current === undefined) return
          if (current.grantedScope !== undefined && status.grantedScope !== current.grantedScope) {
            this.invalidate(id, 'invalid-grant')
          }
          current.grantedScope = status.grantedScope
        }, () => { /* a failed status read leaves the next authority event to re-judge */ })
        return
      }
      case 'invalidated':
        this.invalidate(id, 'invalid-grant')
        return
      case 'revoked':
        this.invalidate(id, 'revoked')
        return
      case 'disposed':
        this.invalidate(id, 'removed')
        return
    }
  }

  /**
   * Fan an invalidation out to one connection's consumers with contained
   * listener failures: every listener runs, a throwing one is logged without
   * changing the withdrawal.
   */
  private invalidate(id: string, reason: ConnectionInvalidation): void {
    const connection = this.connections.get(id)
    if (connection === undefined) return
    connection.epoch += 1
    for (const listener of [...connection.listeners]) {
      try {
        listener(reason)
      } catch (error) {
        this.ctx.logger.warn('mcp-connections: an invalidation listener for "%s" failed', id)
        this.ctx.logger.warn(error)
      }
    }
  }

  /** Constructor-time reconcile: a fresh map admits additions only, so nothing awaits. */
  private reconcileNow(next: McpConnectionsSettings): void {
    for (const [id, entry] of Object.entries(next)) this.addConnection(id, entry)
  }

  /**
   * Apply one committed settings value: add new connections, swap changed
   * ones behind a config-generation bump and an immediate invalidation, and
   * remove absent ones. Changes and removals invalidate BEFORE the old engine
   * is disposed so consumers fence their live generation first.
   */
  private async reconcile(next: McpConnectionsSettings): Promise<void> {
    const seen = new Set<string>()
    for (const [id, entry] of Object.entries(next)) {
      seen.add(id)
      const existing = this.connections.get(id)
      const generation = this.configGenerations.get(id) ?? 0
      const spec = resolveSpec(entry, generation)
      if (existing === undefined) {
        this.addConnection(id, entry)
        continue
      }
      if (specFingerprint(existing.spec, existing.entry.label ?? id) === specFingerprint(spec, entry.label ?? id)) continue
      this.invalidate(id, 'config-changed')
      this.retireConnection(existing)
      await existing.engine?.dispose()
      existing.engine = undefined
      this.configGenerations.set(id, generation + 1)
      // Swap in place: bindings capture this ConnectionState, so replacing the
      // record would orphan their listeners and pin them to the retired engine.
      existing.entry = entry
      existing.spec = resolveSpec(entry, generation + 1)
      existing.grantedScope = undefined
      this.equipConnection(existing)
      // The first invalidation fences consumers synchronously; this second one
      // re-signals once the new authority exists, so a bounce that judged the
      // connection mid-swap (old engine retired, new not yet registered)
      // re-evaluates instead of holding on the disposed engine.
      this.invalidate(id, 'config-changed')
    }
    for (const [id, existing] of [...this.connections]) {
      if (seen.has(id)) continue
      this.invalidate(id, 'removed')
      this.retireConnection(existing)
      await existing.engine?.dispose()
      existing.engine = undefined
      this.connections.delete(id)
    }
  }

  /** Register one connection's persistent state and equip it from its settings entry. */
  private addConnection(id: string, entry: McpConnectionEntry): void {
    const connection: ConnectionState = {
      id,
      credentialKey: this.recordKeyFor(id),
      entry,
      spec: resolveSpec(entry, this.configGenerations.get(id) ?? 0),
      engine: undefined,
      flowDispose: undefined,
      listeners: new Set(),
      consumers: new Map(),
      grantedScope: undefined,
      epoch: 0,
    }
    this.equipConnection(connection)
    this.connections.set(id, connection)
  }

  /** (Re)create one connection's engine and authorization flow from its current entry and spec. */
  private equipConnection(connection: ConnectionState): void {
    let engine: McpConnectionEngine | undefined
    try {
      engine = this.engineFactory({
        ctx: this.ctx,
        credentialKey: connection.credentialKey,
        spec: connection.spec,
        onChange: change => this.onEngineChange(connection.id, change),
      })
    } catch (error) {
      // Engine construction failure leaves the connection configured but
      // unavailable; the logged token names the failure class only.
      this.ctx.logger.error('mcp-connections: connection "%s" is unavailable (%s)', connection.id, errorToken(error))
    }
    connection.engine = engine
    if (engine !== undefined) {
      connection.flowDispose = this.ctx.authorization.registerFlow({
        key: connection.credentialKey,
        label: connection.entry.label ?? connection.id,
        methods: [{ id: 'oauth', label: 'Sign in' }],
        run: session => engine.authorize(session),
      })
    }
  }

  /** Withdraw one connection's flow registration; its engine is disposed by the caller. */
  private retireConnection(connection: ConnectionState): void {
    connection.flowDispose?.()
    connection.flowDispose = undefined
  }

  /** Service teardown: tell consumers the connections are gone, then quiesce every engine. */
  private async disposeEngines(): Promise<void> {
    for (const id of [...this.connections.keys()]) this.invalidate(id, 'removed')
    const engines = [...this.connections.values()].map(connection => connection.engine)
    this.connections.clear()
    await Promise.allSettled(engines.map(engine => engine?.dispose()))
  }
}
