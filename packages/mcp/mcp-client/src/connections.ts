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
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { scopeOf } from '@deepseek-ai/dsh-scope'
// Side-effect type import: declaration-merges `ctx.settings` onto Context.
import type {} from '@deepseek-ai/dsh-settings'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { errorToken } from './connection.ts'
import type { ConnectionInvalidation, ConnectionSource } from './connection.ts'
import { McpOAuthConnection } from './oauth.ts'
import type { McpOAuthChangeEvent, McpOAuthOptions, McpOAuthRevocation, McpOAuthStatus } from './oauth.ts'

export type { McpOAuthChange, McpOAuthChangeEvent, McpOAuthRevocation } from './oauth.ts'

/** Settings namespace holding every host-managed MCP connection (nonsecret). */
export const SETTINGS_NS = 'mcp-connections'

/** Credential record scope addressing this service's grant records. */
const RECORD_SCOPE = 'mcp-connections'

/** Service name on `ctx`, consumed agent-side through `ctx.get`. */
const SERVICE_NAME = 'nativeMcpConnections'

/** Connection id grammar: a credential key segment of at most 64 characters, shared with the agent-side config schema. */
export const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** Whether a string may address a connection (and its grant record). */
function isConnectionId(id: string): boolean {
  return CONNECTION_ID_PATTERN.test(id) && isCredentialKeySegment(id)
}

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
    if (!isConnectionId(id)) {
      throw new TypeError(`mcp-connections key "${id}" must match ${String(CONNECTION_ID_PATTERN)} (it addresses the grant record mcp-connections/${id})`)
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
   * The record identities this engine vouches for at this instant — what it
   * last stored plus writes inside the store right now — as a classifier the
   * service captures synchronously on every `credentials/record-updated` for
   * the connection's key and applies to the record its asynchronous read
   * returns. The engine's own commits are already reported through
   * `onChange`, so only a record it did not write — an external edit, a
   * deletion, another process's write — withdraws consumers as a change of
   * authority, and a write the engine makes after the event cannot hide it.
   * @returns a classifier over the bounded identities captured now.
   */
  captureOwnership(): (record: CredentialRecord | undefined) => boolean
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
   * Observer of the durable transitions the engine commits, each carrying the
   * epoch and effective scope of that commit; the service maps them to
   * consumer invalidations. The engine contains observer failures.
   * @param event - the committed transition and its facts.
   */
  onChange: (event: McpOAuthChangeEvent) => void
}

/**
 * Construct the protocol engine for one connection. Injectable so tests
 * substitute engines without touching OAuth; production uses the default.
 */
export type McpConnectionEngineFactory = (init: McpConnectionEngineInit) => McpConnectionEngine

/**
 * The production engine — `src/oauth.ts` over this Host's credential seam —
 * for one connection, with the service observing its transitions. Tests
 * that need the real protocol engine over a fake network pass `fetch` and
 * `now`; production passes nothing.
 * @param init - the connection the engine serves.
 * @param options - external fetch and clock beneath the engine's own validation.
 * @returns the engine.
 */
export function createOAuthEngine(init: McpConnectionEngineInit, options: Omit<McpOAuthOptions, 'onChange'> = {}): McpConnectionEngine {
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
  }, { ...options, onChange: init.onChange })
}

// ---- Resolved spec ----

/**
 * Frozen connection identity and bounds handed to the engine and transport.
 * Grant reuse across configuration changes is fenced by the engine's own
 * grant binding (server, issuer, resource, redirect, client, scopes), which
 * a stored grant must match exactly; no service-side generation is needed.
 */
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
}

/**
 * The one explicit resolve step from a settings entry to the spec the engine
 * and transport run. Defaults materialize here, never inside consumers.
 * @param entry - the settings entry, schema-valid and validate()-approved.
 * @returns the frozen spec.
 */
export function resolveSpec(entry: McpConnectionEntry): ResolvedMcpConnectionSpec {
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
  })
}

/** Fingerprint for change detection: the spec plus the label a flow registration carries. */
function specFingerprint(spec: ResolvedMcpConnectionSpec, label: string): string {
  return JSON.stringify({ ...spec, label })
}

/** The signal's state after an await, which static narrowing from an earlier check cannot know. */
function abortedNow(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Whether two scope strings name the same set of scopes, whatever their order. */
function sameScopeSet(a: string | undefined, b: string | undefined): boolean {
  const scopes = (value: string | undefined): Set<string> => new Set((value ?? '').split(/\s+/).filter(scope => scope !== ''))
  const left = scopes(a)
  const right = scopes(b)
  return left.size === right.size && [...left].every(scope => right.has(scope))
}

// ---- Status views ----

/**
 * Token-free facts about one connection for configuration UIs. `state` is
 * the engine's authorization lifecycle (or `unavailable` while no engine
 * could be constructed or the connection is no longer configured); it says
 * nothing about tool discoverability, which only the consuming agent's
 * supervisor knows.
 */
export interface McpConnectionStatusView {
  /** The settings key addressing this connection. */
  id: string
  /** User-facing name. */
  label: string
  /** MCP endpoint URL (validated userinfo-free). */
  url: string
  /** Whether the connection is declared in settings; a removed connection stays visible while consumers still bind it. */
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

/**
 * Live per-connection state owned by the service. One record per connection
 * id for the service's whole life once a binding exists: removal from
 * settings retires the engine and flow but keeps the record while consumers
 * bind it, so a later re-add reaches those same consumers instead of
 * orphaning them on a record nothing updates.
 */
interface ConnectionState {
  readonly id: string
  readonly credentialKey: CredentialKey
  /** Whether settings currently declare this connection. */
  configured: boolean
  entry: McpConnectionEntry
  spec: ResolvedMcpConnectionSpec
  engine: McpConnectionEngine | undefined
  flowDispose: (() => void) | undefined
  readonly listeners: Set<(reason: ConnectionInvalidation) => void>
  readonly consumers: Map<McpConnectionBinding, string>
  /**
   * Effective scope of the grant consumers last connected against, and the
   * record epoch it was learned at. Seeded from the first committed
   * transition or from the stored grant at equip time, whichever is newer by
   * epoch; a refresh whose committed scope differs from it invalidates.
   */
  effectiveScope: string | undefined
  scopeEpoch: number | undefined
  epoch: number
}

/** Replaceable seams for direct unit tests. */
export interface NativeMcpConnectionsInternals {
  /** Engine construction override; tests substitute OAuth-free engines or the real engine over a fake network. */
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
 * reconcile engines, flows, and bindings live; engine transitions and external
 * credential changes invalidate consumers immediately; a revoked or removed connection
 * hands no transport and cannot resurrect without a new authority signal.
 *
 * Mounts only in the Host composition: an agent-scoped context is refused
 * at construction, and Cordis refuses a second registration of the service
 * name, so one engine per connection exists per Host.
 */
export class NativeMcpConnectionsService extends Service {
  /** The grant store, the config document, and the flow registry are all required. */
  static inject = ['credentials', 'settings', 'authorization']

  private readonly engineFactory: McpConnectionEngineFactory
  private readonly connections = new Map<string, ConnectionState>()

  /**
   * Register the settings namespace, reconcile the stored document, and wire
   * credential/authorization observation. Every registration is an effect on
   * the service fiber, so disposal unwinds flows, watchers, and engines.
   * @param ctx - Host context carrying the credentials, settings, and authorization services.
   * @param internals - replaceable engine factory for direct unit tests.
   * @throws when `ctx` is an agent-scoped context rather than the Host composition.
   */
  constructor(ctx: Context, internals: NativeMcpConnectionsInternals = {}) {
    if (scopeOf(ctx) !== undefined) {
      throw new Error('mcp-connections: NativeMcpConnectionsService is a Host singleton — mount it in the Host composition, not under an agent scope')
    }
    super(ctx, SERVICE_NAME)
    this.engineFactory = internals.engineFactory ?? (init => createOAuthEngine(init))
    const scope = ctx.settings.register(SETTINGS_NS, SettingsSchema, {
      applies: 'live',
      validate: validateConnections,
    })
    scope.watch(async (next) => { await this.reconcile(next) })
    this.reconcileNow(scope.get())
    // A successful authorization reaches consumers through the engine's own
    // `authorized` commit, which carries the grant facts; `authorization/settled`
    // would only repeat it and bounce every consumer twice.
    ctx.on('credentials/record-updated', (key) => {
      if (credentialKeyScope(key) === RECORD_SCOPE) this.judgeRecordChange(credentialKeyId(key))
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
    const connection = this.connection(id)
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
        this.pruneIfOrphaned(connection)
      },
    }
    connection.consumers.set(binding, consumer.serverName)
    return binding
  }

  /**
   * Token-free facts about one connection: configured, or removed from
   * settings while consumers still bind it.
   * @param id - the connection to describe.
   * @returns the status view, or undefined when the service knows no such connection.
   */
  async describe(id: string): Promise<McpConnectionStatusView | undefined> {
    const connection = this.connections.get(id)
    if (connection === undefined) return undefined
    return this.view(connection)
  }

  /**
   * Token-free facts about every known connection, in settings order:
   * configured ones, then removed ones that consumers still bind.
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
    if (!isConnectionId(id)) {
      throw new TypeError(`mcp-connections id "${id}" must match ${String(CONNECTION_ID_PATTERN)}`)
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
   * The record-updated event invalidates consumers on its own: no engine
   * wrote that deletion.
   * @param id - the connection whose grant is removed.
   */
  async removeGrant(id: string): Promise<void> {
    await this.ctx.credentials.deleteRecord(this.recordKeyFor(id))
  }

  /** The configured connection or a loud error naming the fix. */
  private connection(id: string): ConnectionState {
    const connection = this.connections.get(id)
    if (connection === undefined || !connection.configured) {
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
    if (status.state !== 'authorized' || abortedNow(signal) || !this.stillRuns(connection, engine)) return undefined
    // The MCP SDK's StreamableHTTPClientTransport has optional properties typed
    // without `| undefined` (exactOptionalPropertyTypes mismatch with the
    // Transport interface); the SDK constructed the object, so the cast
    // records only that widening.
    return new StreamableHTTPClientTransport(
      new URL(connection.spec.url),
      { fetch: engine.authenticatedFetch(signal) },
    ) as Transport
  }

  /** Whether the engine is still the one the connection runs; a swap or removal during an await retires it. */
  private stillRuns(connection: ConnectionState, engine: McpConnectionEngine): boolean {
    return connection.engine === engine
  }

  /** Token-free view of one connection; every field is a fact the Host owns. */
  private async view(connection: ConnectionState): Promise<McpConnectionStatusView> {
    let status: McpConnectionEngineStatus | undefined
    try {
      status = await connection.engine?.status()
    } catch (error) {
      // An engine that cannot read its grant is reported unavailable, never guessed at.
      this.ctx.logger.warn('mcp-connections: connection "%s" could not report its status (%s)', connection.id, errorToken(error))
    }
    return {
      id: connection.id,
      label: connection.entry.label ?? connection.id,
      url: connection.spec.url,
      configured: connection.configured,
      state: status?.state ?? 'unavailable',
      inFlightAuth: this.ctx.authorization.describe(connection.credentialKey)?.inFlight ?? false,
      consumers: [...connection.consumers.values()],
      epoch: connection.epoch,
    }
  }

  /**
   * Judge one `credentials/record-updated` for a connection's key. The
   * engine's own commits are handled through its transition events; a record
   * the engine did not write — deleted, edited, or written by another process
   * — is a change of authority that withdraws consumers. The ownership the
   * engine vouches for is captured here, synchronously at the event, and the
   * record the asynchronous read returns is classified against that capture:
   * a write the engine makes after the event can therefore never hide the
   * change the event announced, and no judgement is dropped for coming
   * late. Only an engine swap discards it — the swap already invalidated.
   */
  private judgeRecordChange(id: string): void {
    const connection = this.connections.get(id)
    if (connection === undefined) return
    const engine = connection.engine
    if (engine === undefined) {
      this.invalidate(connection, 'stale')
      return
    }
    const owns = engine.captureOwnership()
    void this.ctx.credentials.readRecord(connection.credentialKey).then((record) => {
      if (connection.engine !== engine) return
      if (!owns(record)) this.invalidate(connection, 'stale')
    }, (error: unknown) => {
      // Unreadable is unknown authority: withdraw rather than keep serving a grant that may be gone.
      this.ctx.logger.warn('mcp-connections: could not read the grant record of "%s" after a change (%s)', id, errorToken(error))
      this.invalidate(connection, 'stale')
    })
  }

  /**
   * Map one committed engine transition to the consumer invalidation it
   * means, using the facts the commit itself carried. A refresh is invisible
   * to consumers unless the scope it committed differs from the scope they
   * connected with: then their cached tool registrations belong to a grant
   * that no longer exists and are re-established. Transitions from an engine
   * the connection no longer runs (retired by a config swap or removal) are
   * ignored: that path already invalidated with its own reason.
   */
  private onEngineChange(connection: ConnectionState, engine: McpConnectionEngine, event: McpOAuthChangeEvent): void {
    if (connection.engine !== engine) return
    switch (event.kind) {
      case 'authorized':
        this.rememberScope(connection, event.epoch, event.grantedScope)
        this.invalidate(connection, 'reauthorized')
        return
      case 'refreshed': {
        const narrowed = connection.scopeEpoch !== undefined && !sameScopeSet(connection.effectiveScope, event.grantedScope)
        this.rememberScope(connection, event.epoch, event.grantedScope)
        if (narrowed) this.invalidate(connection, 'invalid-grant')
        return
      }
      case 'invalidated':
        this.invalidate(connection, 'invalid-grant')
        return
      case 'revoked':
        this.invalidate(connection, 'revoked')
        return
      case 'disposed':
        return
    }
  }

  /** Adopt a committed scope fact unless a newer commit already supplied one. */
  private rememberScope(connection: ConnectionState, epoch: number | undefined, scope: string | undefined): void {
    if (epoch === undefined || (connection.scopeEpoch !== undefined && epoch <= connection.scopeEpoch)) return
    connection.effectiveScope = scope
    connection.scopeEpoch = epoch
  }

  /**
   * Seed the scope baseline from a grant that already existed when the engine
   * was equipped (a Host restart or a config swap), so the first refresh
   * after it is judged against the grant consumers actually connect with.
   * A commit that lands before this read resolves is newer by epoch and wins.
   */
  private seedScope(connection: ConnectionState, engine: McpConnectionEngine): void {
    void engine.status().then((status) => {
      if (connection.engine !== engine || status.state !== 'authorized') return
      this.rememberScope(connection, status.epoch, status.grantedScope)
    }, () => { /* an unreadable grant seeds nothing; the first committed transition seeds instead */ })
  }

  /**
   * Fan an invalidation out to one connection's consumers with contained
   * listener failures: every listener runs, a throwing one is logged without
   * changing the withdrawal.
   */
  private invalidate(connection: ConnectionState, reason: ConnectionInvalidation): void {
    const { id } = connection
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
   * Apply one committed settings value: add new connections (re-equipping a
   * removed one consumers still bind), swap changed ones behind an immediate
   * invalidation, and retire absent ones. Changes and removals invalidate
   * BEFORE the old engine is disposed so consumers fence their live
   * generation first, and the retired engine is detached before disposal so
   * its own `disposed` transition cannot re-signal with the wrong reason.
   */
  private async reconcile(next: McpConnectionsSettings): Promise<void> {
    const seen = new Set<string>()
    for (const [id, entry] of Object.entries(next)) {
      seen.add(id)
      const existing = this.connections.get(id)
      const spec = resolveSpec(entry)
      if (existing === undefined) {
        this.addConnection(id, entry)
        continue
      }
      const unchanged = existing.configured
        && specFingerprint(existing.spec, existing.entry.label ?? id) === specFingerprint(spec, entry.label ?? id)
      if (unchanged) continue
      this.invalidate(existing, existing.configured ? 'config-changed' : 'removed')
      await this.retireConnection(existing)
      // Swap in place: bindings capture this ConnectionState, so replacing the
      // record would orphan their listeners and pin them to the retired engine.
      existing.configured = true
      existing.entry = entry
      existing.spec = spec
      this.equipConnection(existing)
      // The first invalidation fences consumers synchronously; this second one
      // re-signals once the new authority exists, so a bounce that judged the
      // connection mid-swap (old engine retired, new not yet registered)
      // re-evaluates instead of holding on the disposed engine.
      this.invalidate(existing, 'config-changed')
    }
    for (const [id, existing] of [...this.connections]) {
      if (seen.has(id) || !existing.configured) continue
      existing.configured = false
      this.invalidate(existing, 'removed')
      await this.retireConnection(existing)
      this.pruneIfOrphaned(existing)
    }
  }

  /** Register one connection's persistent state and equip it from its settings entry. */
  private addConnection(id: string, entry: McpConnectionEntry): void {
    const connection: ConnectionState = {
      id,
      credentialKey: this.recordKeyFor(id),
      configured: true,
      entry,
      spec: resolveSpec(entry),
      engine: undefined,
      flowDispose: undefined,
      listeners: new Set(),
      consumers: new Map(),
      effectiveScope: undefined,
      scopeEpoch: undefined,
      epoch: 0,
    }
    this.equipConnection(connection)
    this.connections.set(id, connection)
  }

  /**
   * (Re)create one connection's engine and authorization flow from its
   * current entry and spec. A failure at either step leaves the connection
   * configured but unavailable with nothing leaked: an engine whose flow
   * cannot register is disposed again.
   */
  private equipConnection(connection: ConnectionState): void {
    connection.effectiveScope = undefined
    connection.scopeEpoch = undefined
    let engine: McpConnectionEngine
    try {
      engine = this.engineFactory({
        ctx: this.ctx,
        credentialKey: connection.credentialKey,
        spec: connection.spec,
        onChange: (event) => { this.onEngineChange(connection, engine, event) },
      })
    } catch (error) {
      // Engine construction failure leaves the connection configured but
      // unavailable; the logged token names the failure class only.
      this.ctx.logger.error('mcp-connections: connection "%s" is unavailable (%s)', connection.id, errorToken(error))
      return
    }
    let flowDispose: () => void
    try {
      flowDispose = this.ctx.authorization.registerFlow({
        key: connection.credentialKey,
        label: connection.entry.label ?? connection.id,
        methods: [{ id: 'oauth', label: 'Sign in' }],
        run: session => engine.authorize(session),
      })
    } catch (error) {
      this.ctx.logger.error('mcp-connections: connection "%s" cannot register its authorization flow and is unavailable (%s)', connection.id, errorToken(error))
      void engine.dispose().catch(() => { /* a failed disposal of an engine that never served changes nothing */ })
      return
    }
    connection.engine = engine
    connection.flowDispose = flowDispose
    this.seedScope(connection, engine)
  }

  /** Withdraw one connection's flow registration and quiesce its engine, detached first so its transitions are ignored. */
  private async retireConnection(connection: ConnectionState): Promise<void> {
    connection.flowDispose?.()
    connection.flowDispose = undefined
    const engine = connection.engine
    connection.engine = undefined
    await engine?.dispose()
  }

  /** Forget a removed connection once nothing binds it; a bound one stays reachable for a later re-add. */
  private pruneIfOrphaned(connection: ConnectionState): void {
    if (!connection.configured && connection.consumers.size === 0 && connection.listeners.size === 0) {
      this.connections.delete(connection.id)
    }
  }

  /** Service teardown: tell consumers the connections are gone, then quiesce every engine. */
  private async disposeEngines(): Promise<void> {
    const states = [...this.connections.values()]
    for (const connection of states) this.invalidate(connection, 'removed')
    this.connections.clear()
    await Promise.allSettled(states.map(connection => this.retireConnection(connection)))
  }
}
