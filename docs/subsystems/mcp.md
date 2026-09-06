# MCP Host Connections

English | [中文](mcp.zh.md)

The host-managed connection seam of [dsh-mcp-client](../../packages/mcp/mcp-client) keeps an OAuth-requiring MCP server's endpoint, client parameters, and tokens on the Host: the Host connection owner (`ctx.nativeMcpConnections`) holds the settings-backed nonsecret configs, runs one OAuth protocol engine per connection, registers the native authorization flow a human signs in through, and hands agent-side plugin instances bindings whose transports are authenticated by the engine's Host-owned fetch. Grants live in native credential records under `mcp-connections/<connectionId>`, written only through `ctx.credentials.modifyRecord` by the engine; the service never stores tokens, and every status view is token-free. Per-agent plugin configuration, tool naming, and the reconnect policy stay in the package README; the credential record and authorization-flow vocabulary this page builds on lives in [credentials.md](credentials.md).

Source: [`packages/mcp/mcp-client/src/connections.ts`](../../packages/mcp/mcp-client/src/connections.ts)

## Connection entries

The `mcp-connections` settings namespace holds one entry per host-managed connection, keyed by connection id. Every field is nonsecret — the endpoint and the OAuth client parameters the protocol engine needs; grants never appear here. The schema admits the entry, then a validate step refuses what the schema cannot express at the write: HTTPS userinfo-free URLs, and the connection-id grammar the credential record keys depend on.

```ts type-equiv
/**
 * One host-managed MCP connection as the settings document stores it. Every
 * field is nonsecret: the endpoint and the OAuth client parameters the
 * protocol engine needs. Grants never appear here.
 */
interface McpConnectionEntry {
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
```

```ts type-equiv
/** Resolved value of the `mcp-connections` settings namespace, keyed by connection id. */
type McpConnectionsSettings = Record<string, McpConnectionEntry>
```

## Resolved spec

`resolveSpec()` is the one explicit resolve step from a settings entry to the frozen spec the engine and transport run; defaults materialize there, never inside consumers. Grant reuse across configuration changes is fenced by the engine's own grant binding — server, issuer, resource, redirect, client, scopes — which a stored grant must match exactly; no service-side generation is needed.

```ts type-equiv
/**
 * Frozen connection identity and bounds handed to the engine and transport.
 * Grant reuse across configuration changes is fenced by the engine's own
 * grant binding (server, issuer, resource, redirect, client, scopes), which
 * a stored grant must match exactly; no service-side generation is needed.
 */
interface ResolvedMcpConnectionSpec {
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
```

## The engine seam

One protocol engine per connection, owned by the service. All token movement — refresh included — stays inside the engine's own serialized operation queue, and the bridge never reads grant payloads. The default factory constructs the OAuth engine of `src/oauth.ts`; deployments and tests can substitute their own. Engine construction or flow-registration failure leaves the connection configured but unavailable with nothing leaked, logged with a token naming the failure class only.

```ts type-equiv
/**
 * The protocol engine surface the Host bridge relies on. One instance per
 * connection, owned by this service. All token movement — refresh included —
 * stays inside the engine's own serialized operation queue; the bridge never
 * reads grant payloads.
 */
interface McpConnectionEngine {
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
   * Refuse locally and notify consumers before awaiting storage. Commit the
   * tombstone before any bounded remote attempt. A failed write leaves this engine refused.
   * @returns the committed local outcome and the bounded remote outcome.
   */
  revoke(): Promise<McpOAuthRevocation>
  /** Abort owned work and await quiescence. */
  dispose(): Promise<void>
}
```

```ts type-equiv
/** Inputs the service hands the engine factory for one connection. */
interface McpConnectionEngineInit {
  /** Host context, for the credential seam and logger. */
  ctx: Context
  /** The grant record this engine alone writes. */
  credentialKey: CredentialKey
  /** Frozen connection identity and network bounds from settings. */
  spec: ResolvedMcpConnectionSpec
  /**
   * Observer of engine authority transitions. Committed changes carry their
   * epoch and effective scope; local revocation arrives before persistence,
   * without an epoch. The service invalidates consumers; the engine contains observer failures.
   * @param event - the authority transition and its committed or local facts.
   */
  onChange: (event: McpOAuthChangeEvent) => void
}
```

```ts type-equiv
/**
 * Construct the protocol engine for one connection. Injectable so tests
 * substitute engines without touching OAuth; production uses the default.
 */
type McpConnectionEngineFactory = (init: McpConnectionEngineInit) => McpConnectionEngine
```

Committed transitions are events carrying the commit's own facts — the record epoch and the effective granted scope — so the service judges a refresh's scope change from the operation's data, never from a later status read another commit may have overtaken. Local revocation is the one transition reported before persistence: it arrives without an epoch, because consumers must stop at once. A `credentials/record-updated` for a connection's key is judged through a `captureOwnership` classifier captured synchronously at the event and applied to the record the asynchronous read returns: it vouches for what the engine last stored plus writes in flight at that instant, the engine's own commits already arrived through `onChange`, and only a record it did not write — an external edit, a deletion, another process's write — withdraws consumers as a change of authority, while a write the engine makes after the event cannot hide it.

The engine's lifecycle status is the OAuth engine's token-free status view: whether a grant can serve requests, why not while it cannot, the in-flight operation, and grant facts safe for status surfaces.

```ts type-equiv
/** Token-free engine lifecycle facts; the UI vocabulary the Host may repeat. */
type McpConnectionEngineStatus = McpOAuthStatus
```

```ts type-equiv
/** Token-free lifecycle facts for status surfaces. */
interface McpOAuthStatus {
  /** Whether a grant can currently serve requests. */
  state: 'auth-required' | 'authorized' | 'revoked' | 'disposed'
  /** Why no grant serves, while `state` is `auth-required`. */
  reason?: 'no-grant' | 'record-invalid' | 'binding-changed' | 'grant-invalidated'
  /** The engine operation running now, if any. */
  inFlight: 'authorize' | 'refresh' | undefined
  /** Whether the stored grant can be refreshed without the human. */
  hasRefreshToken: boolean
  /** Advertised access-token expiry as epoch milliseconds; absent when the server advertised none. */
  accessTokenExpiresAt: number | undefined
  /** Effective granted scope: the server's `scope` response, else the scope the grant already had (RFC 6749 §5.1, §6). */
  grantedScope: string | undefined
  /** Record epoch; absent while nothing valid is stored, and while locally revoked, when the store is not consulted. */
  epoch: number | undefined
}
```

A refresh is invisible to consumers unless the scope set it committed differs from the scope they connected with; authorization and invalidation invalidate once committed, revocation invalidates at the first synchronous step — before its tombstone is stored — and transitions from an engine the connection no longer runs are ignored: the path that retired it already invalidated with its own reason.

```ts type-equiv
/**
 * Transitions the engine reports; the bridge resyncs or drops tools on them.
 * All but `revoked` and `disposed` are reported once committed; `revoked` is
 * reported at the first synchronous step of revocation, before its tombstone
 * is stored, because consumers must stop at once.
 */
type McpOAuthChange = 'authorized' | 'refreshed' | 'invalidated' | 'revoked' | 'disposed'
```

```ts type-equiv
/**
 * One authority transition. Committed changes carry their own epoch and
 * effective scope, not a later status read another commit may have overtaken.
 * A `revoked` event reports immediate local refusal, not a durable-write acknowledgement.
 */
interface McpOAuthChangeEvent {
  /** The transition. */
  kind: McpOAuthChange
  /**
   * Record epoch the commit wrote; absent for `disposed`, which writes
   * nothing, and for `revoked`, which is reported before its tombstone is stored.
   */
  epoch: number | undefined
  /** Effective granted scope of the committed grant; absent unless `authorized` or `refreshed`. */
  grantedScope: string | undefined
}
```

## Status views

`describe()` and `list()` answer configuration surfaces with token-free facts: configured connections, plus removed ones consumers still bind — removal retires the engine and flow but keeps the connection reachable until nothing binds it, so a later re-add reaches the same consumers instead of orphaning them. `state` is the engine's authorization lifecycle — `unavailable` while no engine could be constructed or the connection is no longer configured — and says nothing about tool discoverability, which only the consuming agent's supervisor knows. A Host-latched refusal is reported as `revoked` from the Host's own fence without consulting the store — a store that hangs or fails must not delay or hide it — and every engine read is re-judged against a refusal that arrived during it.

```ts type-equiv
/**
 * Token-free facts about one connection for configuration UIs. `state` is
 * the engine's authorization lifecycle (or `unavailable` while no engine
 * could be constructed or the connection is no longer configured); it says
 * nothing about tool discoverability, which only the consuming agent's
 * supervisor knows.
 */
interface McpConnectionStatusView {
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
```

## Bindings

`acquire()` binds one agent-side consumer to a configured connection and fails loud on an unknown or removed id. The binding is the connection source the mcp-client supervisor runs: the supervisor re-evaluates `connect` fresh at every generation start and never caches its result across an invalidation, so a revoked or removed connection hands no transport and cannot resurrect without a new authority signal. Transport-level outages never appear as invalidations — they stay on the ordinary reconnect path.

```ts type-equiv
/**
 * External authority over one connection's transport availability, supplied
 * by the Host connection owner for `host-connection` configs. The supervisor
 * re-evaluates {@link connect} fresh at every generation start and never
 * caches its result across an invalidation, so a revoked or removed
 * connection hands no transport and cannot resurrect on its own.
 */
interface ConnectionSource {
  /**
   * Resolve the transport for the NEXT generation.
   * @param signal - aborted when this attempt is superseded (an invalidation or disposal).
   * @returns a fresh transport, or `undefined` while the authority holds the
   *   connection down (unauthorized, revoked, unavailable, or removed).
   */
  connect(signal: AbortSignal): Promise<Transport | undefined>
  /**
   * Subscribe to authority changes: revocation, scope or config changes,
   * re-authorization, removal.
   * @param listener - invoked synchronously with the withdrawal reason.
   * @returns the unsubscriber.
   */
  onInvalidate(listener: (reason: ConnectionInvalidation) => void): () => void
}
```

```ts type-equiv
/**
 * Why the authority over a host-managed connection told consumers to
 * re-evaluate it. Transport-level outages never appear here — they stay on
 * the ordinary reconnect path.
 */
type ConnectionInvalidation = 'revoked' | 'invalid-grant' | 'stale' | 'config-changed' | 'reauthorized' | 'removed'
```

```ts type-equiv
/**
 * One agent-side consumer's handle on a host connection: the
 * {@link ConnectionSource} the mcp-client supervisor runs, plus the release
 * that unregisters the consumer.
 */
interface McpConnectionBinding extends ConnectionSource {
  /** Authority epoch of the connection; bumped on every invalidation. */
  readonly epoch: number
  /** Unregister this consumer; idempotent. */
  release(): void
}
```

## Revocation

Revocation refuses locally before it persists: the engine latches the local revocation, aborts in-flight managed requests and the running operation, and reports `revoked` before the first storage await, so a request arriving while the tombstone write is pending — or after it failed — is refused rather than served from the record the store still holds, and only an explicit re-authorization lifts the latch. The `revoked` event therefore reports immediate local refusal, not a durable-write acknowledgement. The tombstone must commit before any bounded remote revocation attempt; an unconfirmed write throws `STORE` — the stored state is then unknown, no remote attempt runs, and the authorization-server token may still live — and the remote outcome is reported truthfully, never assumed. The Host fences the refused credential key outside any connection state, so the refusal outlives the engine that latched it — a config swap builds a new engine over the same store — the connection's removal and re-add, even one naming a different endpoint (the fence keys the credential record, not the config), and consumer pruning; only a new explicit authorization entered after the latest latched revocation and committed lifts the fence, while an attempt that merely entered earlier is refused at its start and at publication. The fence is memory-only: a Host restart forgets it, and when the tombstone write failed, only the durable record governs afterwards — and it may still hold the grant. `removeGrant()` deletes the grant record outright — the forget operation — and since no engine wrote that deletion, the record-updated judgement withdraws consumers on its own.

```ts type-equiv
/** Outcome of {@link McpOAuthConnection.revoke}; the local tombstone is committed before any remote attempt. */
interface McpOAuthRevocation {
  local: 'revoked'
  /** `no-grant` when nothing was stored, `unsupported` when the server advertises no revocation endpoint. */
  remote: 'no-grant' | 'unsupported' | 'succeeded' | 'failed'
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxnativemcpconnections--nativemcpconnectionsservice"></a>

### `ctx.nativeMcpConnections` — `NativeMcpConnectionsService`

`ctx.nativeMcpConnections`: the Host connection owner. Settings changes reconcile engines, flows, and bindings live; engine transitions and external credential changes invalidate consumers immediately; a revoked or removed connection hands no transport and cannot resurrect without a new authority signal.

Mounts only in the Host composition: an agent-scoped context is refused at construction, and Cordis refuses a second registration of the service name, so one engine per connection exists per Host.

```ts cordis-catalog
/**
 * Bind one agent-side consumer to a configured connection.
 * @param id - the settings key of the connection to consume.
 * @param consumer - the consumer's public tool namespace, for status bookkeeping.
 * @returns the binding the mcp-client supervisor runs as its connection source.
 * @throws when no connection with this id is configured.
 */
acquire(id: string, consumer: { serverName: string }): McpConnectionBinding

/**
 * Token-free facts about one connection: configured, or removed from
 * settings while consumers still bind it.
 * @param id - the connection to describe.
 * @returns the status view, or undefined when the service knows no such connection.
 */
async describe(id: string): Promise<McpConnectionStatusView | undefined>

/**
 * Token-free facts about every known connection, in settings order:
 * configured ones, then removed ones that consumers still bind.
 * @returns one status view per connection.
 */
async list(): Promise<McpConnectionStatusView[]>

/**
 * The grant record key a surface needs to drive this connection's
 * authorization flow through `ctx.authorization`.
 * @param id - the connection whose flow key is asked.
 * @returns the credential record key.
 */
recordKeyFor(id: string): CredentialKey

/**
 * Revoke one connection's grant: the engine refuses locally and its
 * synchronous `revoked` transition invalidates consumers before storage is
 * awaited. The tombstone must commit before any remote revocation attempt.
 * @param id - the connection to revoke.
 * @returns the local outcome and the bounded remote outcome.
 */
async revoke(id: string): Promise<McpOAuthRevocation>

/**
 * Delete one connection's grant record outright (the "forget" operation).
 * The record-updated event invalidates consumers on its own: no engine
 * wrote that deletion.
 * @param id - the connection whose grant is removed.
 */
async removeGrant(id: string): Promise<void>
```

Types: [CredentialKey](credentials.md)

Source: [`packages/mcp/mcp-client/src/connections.ts`](../../packages/mcp/mcp-client/src/connections.ts)
<!-- END GENERATED cordis-surface -->
