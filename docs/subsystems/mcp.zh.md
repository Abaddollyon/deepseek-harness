# MCP Host 连接

[English](mcp.md) | 中文

[dsh-mcp-client](../../packages/mcp/mcp-client) 的 Host 托管连接 seam 把需要 OAuth 的 MCP 服务器的端点、客户端参数与令牌保留在 Host 上：Host 连接所有者（`ctx.nativeMcpConnections`）持有设置支撑的非机密配置，为每个连接运行一个 OAuth 协议引擎，注册供人完成登录的原生授权流程，并把绑定交给 agent 侧插件实例——绑定给出的传输由引擎的 Host 持有的 fetch 完成认证。grant（授权）保存在 `mcp-connections/<connectionId>` 下的原生凭据记录中，只由引擎通过 `ctx.credentials.modifyRecord` 写入；服务本身绝不存储令牌，所有状态视图都不含令牌。逐 agent 插件配置、工具命名与重连策略仍由包 README 负责；本页所依赖的凭据记录与授权流程词汇见 [credentials.md](credentials.zh.md)。

来源：[`packages/mcp/mcp-client/src/connections.ts`](../../packages/mcp/mcp-client/src/connections.ts)

## 连接条目

`mcp-connections` 设置命名空间按连接 id 为每个 Host 托管连接保存一条条目。每个字段都是非机密的——端点与协议引擎所需的 OAuth 客户端参数；授权绝不会出现在这里。schema 接纳条目后，validate 步骤会在写入时拒绝 schema 无法表达的内容：不含 userinfo 的 HTTPS URL，以及凭据记录键所依赖的连接 id 语法。

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

## 解析出的 spec

`resolveSpec()` 是从设置条目到引擎与传输实际运行的冻结 spec 的唯一显式解析步骤；默认值在这里物化，绝不在消费方内部补默认。跨配置变化的授权复用由引擎自己的授权绑定——server、issuer、resource、redirect、client、scopes——隔离，已存储的授权必须与之精确匹配；不需要服务侧的世代计数。

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

## 引擎 seam

每个连接一个协议引擎，由服务持有。所有令牌流动——包括刷新——都留在引擎自己的串行操作队列内，桥接层绝不读取授权载荷。默认工厂构造 `src/oauth.ts` 的 OAuth 引擎；部署方与测试可以替换自己的实现。引擎构造或授权流程注册失败会让连接保持已配置但不可用且不泄漏任何资源，日志只记录标明失败类别的 token。

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
   * Local-first revocation: the local tombstone is committed before any bounded remote attempt.
   * @returns the local outcome and the bounded remote outcome.
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
   * Observer of the durable transitions the engine commits, each carrying the
   * epoch and effective scope of that commit; the service maps them to
   * consumer invalidations. The engine contains observer failures.
   * @param event - the committed transition and its facts.
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

已提交的变迁是携带本次提交自身事实的事件——记录 epoch 与生效的授予 scope——因此服务根据操作自身的数据判断一次刷新的 scope 变化，绝不依赖可能已被另一次提交超越的事后状态读取。连接键上的 `credentials/record-updated` 通过在事件发生时同步捕获的 `captureOwnership` 分类器判定，并应用于异步读取所返回的记录：它为引擎当时最后存储的内容以及正在进行的写入作证；引擎自己的提交已经经由 `onChange` 上报，只有不是它写入的记录——外部编辑、删除、另一个进程的写入——才会作为权威变化使消费方失效，而引擎在事件之后做出的写入无法掩盖这一点。

引擎的生命周期状态就是 OAuth 引擎的无令牌状态视图：授权当前能否服务请求、不能服务时的原因、进行中的操作，以及可安全呈现在状态界面上的授权事实。

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
  /** Record epoch, absent while nothing valid is stored. */
  epoch: number | undefined
}
```

刷新通常对消费方不可见，除非它提交的 scope 集合与消费方连接时的 scope 不同；授权、失效与撤销各自都会立即使消费方失效；来自连接已不再运行的引擎的变迁会被忽略——使其退役的路径已经用它自己的原因完成过失效。

```ts type-equiv
/** Durable transitions the engine committed; the bridge resyncs or drops tools on them. */
type McpOAuthChange = 'authorized' | 'refreshed' | 'invalidated' | 'revoked' | 'disposed'
```

```ts type-equiv
/**
 * One committed transition with the facts of that commit, so an observer
 * judges scope and identity from the operation's own data rather than from a
 * later status read that another commit may already have overtaken.
 */
interface McpOAuthChangeEvent {
  /** The transition. */
  kind: McpOAuthChange
  /** Record epoch the commit wrote; absent for `disposed`, which writes nothing. */
  epoch: number | undefined
  /** Effective granted scope of the committed grant; absent unless `authorized` or `refreshed`. */
  grantedScope: string | undefined
}
```

## 状态视图

`describe()` 与 `list()` 以无令牌的事实回答配置界面：已配置的连接，以及被移除但仍有消费方绑定的连接——移除会让引擎与授权流程退役，但在没有任何绑定之前保持连接可达，因此之后的重新添加能到达同一批消费方，而不是把它们遗弃。`state` 是引擎的授权生命周期——引擎无法构造或连接不再被配置时为 `unavailable`——它不说明工具可发现性，后者只有消费方 agent 的监督器知道。

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

## 绑定

`acquire()` 把一个 agent 侧消费方绑定到一个已配置的连接，遇到未知或已移除的 id 会明确报错。绑定就是 mcp-client 监督器运行的连接来源：监督器在每个世代开始时重新求值 `connect`，绝不会跨失效缓存其结果，因此被撤销或被移除的连接不会交出传输，也没有新的权威信号就无法复活。传输层中断绝不会以失效的形式出现——它们留在普通重连路径上。

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

## 撤销

撤销是本地优先的：引擎先提交本地墓碑记录，再尝试有界的远程撤销，其 `revoked` 变迁会使每个消费方失效，因此撤回立即生效。`removeGrant()` 直接删除授权记录——即“遗忘”操作——由于没有任何引擎写入过这次删除，记录更新判定会自行使消费方失效。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * Revoke one connection's grant: the engine commits the local tombstone
 * first and its `revoked` transition invalidates every consumer, so the
 * withdrawal takes effect immediately.
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

Types: [CredentialKey](credentials.zh.md)

Source: [`packages/mcp/mcp-client/src/connections.ts`](../../packages/mcp/mcp-client/src/connections.ts)
<!-- END GENERATED cordis-surface -->
