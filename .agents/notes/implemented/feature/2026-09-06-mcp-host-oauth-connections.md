# Agent Note: MCP Host-owned OAuth connections

Status: implemented

English | [中文](2026-09-06-mcp-host-oauth-connections.zh.md)

## Problem

The [MCP client](2026-07-07-mcp-client-plugin.md) configured every server with a static URL and headers in per-agent plugin config. An OAuth-requiring server had no harness home: a static token copied into agent-visible config could not refresh, gave every consuming agent its own copy of the credential, and offered no sign-in or revocation path. The endpoint, client parameters, and tokens of such a server are deployment property, not agent configuration.

## Decision

**Host connection owner.** `packages/mcp/mcp-client/src/connections.ts` provides `NativeMcpConnectionsService` (`ctx.nativeMcpConnections`), mounted once in the Host composition. It owns the settings-backed nonsecret connection configs (the `mcp-connections` namespace, validated at the write: HTTPS userinfo-free URLs and the connection-id grammar the record keys depend on), one OAuth protocol engine per connection, the native authorization-flow registrations a human signs in through, and the bindings agent-side instances consume. Grants live in native credential records under `mcp-connections/<connectionId>`, written only through `ctx.credentials.modifyRecord` by the engine; the service never stores tokens, and its status views are token-free. Settings reconcile live: a changed entry invalidates consumers before the old engine retires, and grant reuse across configuration changes is fenced by the engine's own grant binding (server, issuer, resource, redirect, client, scopes), which a stored grant must match exactly. A removed entry invalidates and retires the engine and flow, but the connection stays reachable while consumers bind it, so a later re-add reaches the same consumers instead of orphaning them.

**Protocol engine.** `src/oauth.ts` runs every OAuth step through the MCP SDK's `auth()` orchestration — discovery, RFC 7591 dynamic registration when no client id is configured, PKCE S256, code exchange, refresh — under one serialized operation queue per connection. Code, verifier, and state live only in operation memory; the durable record is written once at commit, and every commit is a compare-and-set on the record epoch the operation observed, so a revoked, disposed, or superseded operation cannot resurrect a grant even when it ignores its abort.

**Interactive authorization without a listener.** Sign-in runs as a native authorization flow: the engine notifies the authorization URL and asks for the complete callback URL through a `secret` prompt, then validates the registered redirect, the random state, the issuer when advertised, and a single code. No local callback listener or port is created.

**Host-owned fetch.** The engine's managed fetch attaches the current bearer token, accepts only the configured endpoint, rejects caller-supplied credential headers, disables redirects, and answers 401 with one shared forced refresh plus one retry before invalidating. The SDK transport receives no `authProvider`, so it can neither spend a rotating refresh token through its own path nor open interactive authorization on an ordinary 401.

**Authority-aware agent bridge.** A plugin entry selects `transport: host-connection` with a `connectionId`; `url`/`headers` beside it are rejected at load, and a missing Host service fails loud. The plugin acquires a binding at activation, the supervisor resolves every generation's transport through it, and an invalidation fences the live generation behind the same close barrier disposal uses: the tool registration is withdrawn first, and re-establishment re-evaluates the authority fresh. Revocation, scope changes, config edits, re-authorization, and removal therefore take effect immediately, and a revoked or removed connection hands no transport and cannot resurrect without a new authority signal. Transport-level outages never surface as invalidations — they stay on the [ordinary reconnect path](2026-08-06-mcp-client-auto-reconnect.md).

**Committed transitions carry their facts.** Each engine transition is an event carrying the commit's record epoch and effective granted scope, so the service judges a refresh's scope change from the operation's own data rather than a later status read another commit may have overtaken; a refresh whose committed scope set differs from what consumers connected with invalidates them, and transitions from a retired engine are ignored. A `credentials/record-updated` the engine did not write — an external edit, a deletion, another process's write — is a change of authority that withdraws consumers; the engine's own commits already arrived through its observer and no longer bounce them.

**Local-first revocation.** Revocation commits the local tombstone before any bounded remote attempt, and the `revoked` transition invalidates every consumer, so the withdrawal takes effect immediately; `removeGrant()` deletes the record outright and the record-updated event invalidates consumers on its own.

The public vocabulary — entries, resolved spec, engine seam, status views, bindings, revocation — is documented on [the MCP Host connections subsystem page](../../../../docs/subsystems/mcp.md), which also carries the generated `ctx.nativeMcpConnections` reference.

## Alternatives considered

**SDK `authProvider` inside the agent-side plugin.** Rejected: token material would enter per-agent configuration and process memory, every agent would refresh independently and race a rotating refresh token, and no single party could represent or revoke the grant. The engine owns all token movement precisely so the SDK transport never needs an `authProvider`.

**Local loopback callback listener.** Rejected: it claims a port per flow and widens the loopback surface for a one-shot handoff. Pasting the completion-page URL through the existing secret-prompt channel carries the same authorization code with no listener at all.

**Static-token fields beside OAuth in the connections schema.** Rejected: a fixed token is exactly the unrefreshable, agent-copied secret this seam exists to remove. Servers needing only a static header keep the legacy `streamable-http` transport; host-managed connections are OAuth-only.

**Cross-process refresh coordination through the credential store.** Rejected for the current contract: no consumer runs two harness processes against one store, so the engine serializes refresh per process and the package README documents the resulting rule — a grant's Host must be a deployment singleton — instead of adding a lock protocol without evidence.

## Testing

`tests/connections.spec.ts` substitutes OAuth-free engines and pins settings reconcile (add, change, removal with bound consumers kept reachable for a re-add), binding fencing across invalidations, contained listener failures, token-free status views, record-change judgement (external edits and deletions withdraw consumers, the engine's own commits do not), scope-narrowing refresh invalidation, local-first revocation ordering, and disposal quiescence. `tests/oauth.spec.ts` drives the real engine through bounded-fetch fixtures: discovery validation, dynamic registration, PKCE and state checks, compare-and-set commits, serialized refresh, the 401 forced-refresh-and-retry path, and revocation outcomes. `tests/reconnect.spec.ts` pins the authority bridge: invalidation fences the live generation, an unauthorized connection hands no transport and holds, and re-authorization re-establishes tools. The focused package suites and the package typecheck pass.

## Consequences

- Tokens never reach agent-side configuration, logs, or status views; agents hold only bindings, and every authority change withdraws and re-establishes tools atomically per generation.
- Host-managed connections are OAuth-only and refresh is serialized per process: a grant's Host must be a deployment singleton, since two harness processes sharing one credential store can both refresh and lose a rotation.
- Sign-in is a human paste-the-callback step per authorization, with no listener; a not-yet-authorized connection yields no transport by design, so `failOnStartupError: true` also rejects that normal cold startup — a documented configuration choice, not an OAuth failure.
- The settings schema, engine seam, and binding vocabulary are new public surface with a subsystem page and generated Cordis reference; future configuration UIs consume the token-free status views rather than any grant payload.
