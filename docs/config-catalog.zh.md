<!-- 英文源文件由 scripts/gen-config-catalog.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-config-catalog` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/config-catalog.md` 重新记录配对。 -->

# 插件配置目录

[English](config-catalog.md) | 中文

每个 `config:` 块均可由 `cordis.yml` 条目设置：针对每个可加载的 harness 包，原样列出其 `apply` 函数或服务构造函数接收的配置声明（包括 JSDoc），并附上所有引用类型——包内类型直接粘贴，其他类型则提供链接。粘贴的内容是插件声明的完整配置类型——运行时 schema 有意排除的字段是仅供运行时使用的 seam（其自身的 JSDoc 会如此说明），不能通过 `cordis.yml` 设置。这是以**部署**为轴的参考文档——插件作者所依据的连接方式请参阅各[子系统页面](subsystems/core.zh.md)中的生成 `cordis-surface` 区域，面向模型的工具 schema 请参阅[工具目录](tool-catalog.zh.md)，而 [subsystems/](subsystems/core.zh.md) 则记录了这些声明所引用的类型。

英文源文件由源代码（`scripts/gen-config-catalog.ts`）生成，并通过 `pnpm run verify-config-catalog`（`doc-sync` 的一部分）验证新鲜度；本中文文件作为经评审对侧通过双语配对维护。声明块使用 `ts config-catalog` 围栏（doc-typecheck 会跳过它，因为单独引用导入项的声明无法独立编译）。英文生成器还会将运行时 schemastery schema 与粘贴的声明进行交叉核对——每个经 schema 验证的键（包括嵌套键）都必须能在声明的配置类型中找到——因此，粘贴内容无法隐藏加载器接受的字段。

`Requires:` 行列出插件通过 `inject` 注入的服务键：其 `cordis.yml` 树还必须加载这些服务的提供者。范围限定为 harness 层级（`packages/`）；配置树还可能加载的 vendored cordis 插件（`hmr`、控制台日志记录器等）固定为上游源代码（参见 [vendoring policy](../vendor/README.md)），未收录于此目录。

<a id="deepseek-aidsh-acp"></a>

## `@deepseek-ai/dsh-acp`

需要：`agents` · `llm` · `sessionPersistence` · `sessions`

```ts config-catalog
/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Maximum summaries returned by one session/list page. */
  sessionListPageSize?: number
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}
```

依赖：`Stream`（`@agentclientprotocol/sdk`）

来源：[`packages/acp/acp/src/index.ts:75`](../packages/acp/acp/src/index.ts)

<a id="deepseek-aidsh-agent-default-model"></a>

## `@deepseek-ai/dsh-agent-default-model`

```ts config-catalog
/** Composition entry for the default model selection. */
export interface Config {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}
```

来源：[`packages/core/agent-default-model/src/index.ts:41`](../packages/core/agent-default-model/src/index.ts)

<a id="deepseek-aidsh-agent-instructions"></a>

## `@deepseek-ai/dsh-agent-instructions`

需要：`sessionProjections`

```ts config-catalog
/** User-facing workspace instruction loader configuration. */
export interface Config {
  /** Harness home containing the fixed user-global `AGENTS.md`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Directory entries that identify the project root while walking upward from the session cwd. */
  projectRootMarkers?: string[]
  /** UTF-8 byte cap for one rendered baseline or dynamic batch; non-positive or non-finite disables loading. */
  maxBytes: number
  /** Maximum UTF-8 bytes read from one instruction file; larger files are ignored. */
  maxSourceBytes?: number
  /**
   * Ordered same-directory project candidates; every existing file loads, with
   * per-directory trimmed-content duplicates collapsed to the earliest candidate.
   */
  instructionFileCandidates?: string[]
  /**
   * Ordered same-directory local-overlay candidates loaded after the base files
   * under the same per-directory trimmed-content dedup; empty disables the overlay.
   */
  localInstructionFileCandidates?: string[]
}
```

来源：[`packages/context/agent-instructions/src/config.ts:18`](../packages/context/agent-instructions/src/config.ts)

<a id="deepseek-aidsh-agent-loop"></a>

## `@deepseek-ai/dsh-agent-loop`

需要：`agents` · `sessions` · `llm` · `tools` · `systemPrompt` · `sessionProjections`

```ts config-catalog
/** Agent-loop plugin configuration. */
export interface Config {
  /**
   * Maximum parallel-safe calls in flight per agent step. `1` is serial;
   * omission defaults to {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}.
   */
  maxParallelToolCalls?: number
  /** Agents created or resumed at plugin startup. */
  agents: (AgentOptions & {
    /** Stable config label used in logs and as the fresh combined-id prefix. */
    id: string
    /** Optional stable identity; remounts resume its materialized history, while first use creates it fresh. */
    sessionId?: SessionId
    /** Optional workspace for a fresh session. */
    cwd?: string
    /** Persisted session to resume instead of creating a fresh session. */
    resumeSessionId?: SessionId
  })[]
}
```

依赖：[`AgentOptions`](subsystems/core.zh.md) · [`SessionId`](subsystems/core.zh.md)

来源：[`packages/core/agent-loop/src/index.ts:311`](../packages/core/agent-loop/src/index.ts)

<a id="deepseek-aidsh-agent-presets"></a>

## `@deepseek-ai/dsh-agent-presets`

需要：`loader` · `sessionProjections`

```ts config-catalog
/** Plugin config: which preset is the default, and where presets live. */
export interface Config {
  /** Preset id mounted when a caller names none. Missing at mount time fails loud. */
  default: string
  /** Scanned roots in precedence order; an earlier root wins a duplicate id. */
  roots: PresetRoot[]
  /**
   * Prepend this package's bundled shipped presets as a `system` root, before
   * every configured root, so the shipped set always mounts and wins a
   * duplicate id. The default survives a whole-`config` patch replacement;
   * only an explicit `false` — a deployment supplying purely its own presets,
   * or an embedder using the roster as bare machinery — drops the set.
   */
  includeShippedRoot: boolean
  /**
   * Append the harness home's `USER_PRESET_DIR` as a `user` root, after every
   * configured root. False mounts a roster without the derived writable root.
   */
  includeUserRoot: boolean
}

/** One directory scanned for preset subdirectories. */
export interface PresetRoot {
  /** Directory holding one subdirectory per preset; a leading `~` expands. */
  path: string
  /** Trust recorded on every preset discovered under this root. */
  trust: PresetTrust
}

/**
 * Where a preset's composition came from. A `system` preset ships with the
 * deployment; a `user` preset was authored locally, by a person or by an
 * agent, and therefore carries the same trust as shell access.
 */
export type PresetTrust = 'system' | 'user'
```

来源：[`packages/preset/agent-presets/src/preset.ts:52`](../packages/preset/agent-presets/src/preset.ts)

<a id="deepseek-aidsh-agent-tool-presentation"></a>

## `@deepseek-ai/dsh-agent-tool-presentation`

需要：`tools`

```ts config-catalog
/** Plugin config. */
export interface Config {
  /**
   * The form this agent's model sees. `native` sends every visible schema,
   * `ptc` sends only `run_code` plus a generated SDK, `both` sends both.
   * Required rather than defaulted: the deployment default is what a preset
   * without this row already gets, so an omitted value would mean the row was
   * composed for nothing.
   */
  mode: ToolPresentationMode
}
```

依赖：[`ToolPresentationMode`](subsystems/tools.zh.md)

来源：[`packages/core/agent-tool-presentation/src/index.ts:38`](../packages/core/agent-tool-presentation/src/index.ts)

<a id="deepseek-aidsh-api-gateway"></a>

## `@deepseek-ai/dsh-api-gateway`

需要：`typert`

```ts config-catalog
/** Gateway transport configuration. */
export interface Config {
  /** WebSocket Ping interval from 1 through 2,147,483,647 milliseconds. @default 2000 */
  readonly websocketHeartbeatIntervalMs?: number
}
```

来源：[`packages/api/gateway/src/index.ts:119`](../packages/api/gateway/src/index.ts)

<a id="deepseek-aidsh-api-session-controller"></a>

## `@deepseek-ai/dsh-api-session-controller`

需要：`agentDefaultModel` · `agents` · `attachments` · `llm` · `sessions` · `sessionProjections` · `sessionQuery` · `typert` · `workspaceRegistry`

```ts config-catalog
/** Session Controller deployment policy. */
export interface Config {
  /** Maximum cold Session artifact size eligible for one full projection observation. */
  readonly coldBlankProbeMaxBytes?: number
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
}
```

来源：[`packages/api/session-controller/src/index.ts:68`](../packages/api/session-controller/src/index.ts)

<a id="deepseek-aidsh-api-settings-controller"></a>

## `@deepseek-ai/dsh-api-settings-controller`

```ts config-catalog
/** Native document-opening policy. */
export interface Config {
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
}
```

来源：[`packages/api/settings-controller/src/index.ts:36`](../packages/api/settings-controller/src/index.ts)

<a id="deepseek-aidsh-attachment-local"></a>

## `@deepseek-ai/dsh-attachment-local`

```ts config-catalog
/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Maximum encoded bytes accepted for one submitted image. Default: 20 MiB. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. Default: 20. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. Default: 200 MiB. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one submitted image. Default: 64,000,000. */
  maxImagePixels?: number
  /** Maximum intrinsic width and maximum intrinsic height accepted for one submitted image. Default: 8192px. */
  maxImageDimension?: number
  /** Total-pixel budget of the stored provider-independent normalized image. */
  normalizedImageMaxPixels?: number
  /** Long-edge pixel cap of the stored provider-independent normalized image, applied after the total-pixel budget. */
  normalizedImageMaxDimension?: number
  /**
   * Encoded-byte target of the stored provider-independent normalized image;
   * the smallest quality-ladder output is kept when no quality fits.
   */
  normalizedImageMaxBytes?: number
  /** Maximum simultaneous normalization or request-image transformations in this service instance. */
  imageCompressionConcurrency?: number
}
```

来源：[`packages/attachment/attachment-local/src/index.ts:55`](../packages/attachment/attachment-local/src/index.ts)

<a id="deepseek-aidsh-bash-local"></a>

## `@deepseek-ai/dsh-bash-local`

需要：`subprocess`

```ts config-catalog
/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Default working directory for commands (default: process.cwd()). */
  cwd?: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes?: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes?: number
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
}
```

来源：[`packages/shell/bash-local/src/index.ts:41`](../packages/shell/bash-local/src/index.ts)

<a id="deepseek-aidsh-bash-sandbox"></a>

## `@deepseek-ai/dsh-bash-sandbox`

需要：`subprocess` · `sandbox` · `sandboxPolicy`

```ts config-catalog
/**
 * Plugin config: the local executor's knobs, verbatim. The sandbox policy —
 * the default mode and fallback `workspace-write` root — is NOT here: it lives
 * on `ctx.sandboxPolicy` (`@deepseek-ai/dsh-sandbox-policy`), which resolves
 * each calling session's mode and cwd for every enforcing capability. The runner
 * choice is likewise the `ctx.sandbox` provider's config, not this executor's.
 */
export type Config = LocalConfig
```

依赖：[`LocalConfig`](#deepseek-aidsh-bash-local)

来源：[`packages/shell/bash-sandbox/src/index.ts:35`](../packages/shell/bash-sandbox/src/index.ts)

<a id="deepseek-aidsh-client-connection"></a>

## `@deepseek-ai/dsh-client-connection`

需要：`webServer` · `credentials`

```ts config-catalog
/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by; the Web runtime derives LAN IP literals from an active all-interface
   * bind. An entry that is not a bare, canonical authority fails plugin load.
   */
  trustedHosts?: string[]
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}
```

来源：[`packages/client/connection/src/index.ts:55`](../packages/client/connection/src/index.ts)

<a id="deepseek-aidsh-client-hmr"></a>

## `@deepseek-ai/dsh-client-hmr`

需要：`clientModules` · `webServer`

```ts config-catalog
/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Bundle stat-poll interval in milliseconds (default 500, the build-side watcher's polling default). */
  pollIntervalMs?: number
}
```

来源：[`packages/client/hmr/src/index.ts:31`](../packages/client/hmr/src/index.ts)

<a id="deepseek-aidsh-code-runtime-worker-thread"></a>

## `@deepseek-ai/dsh-code-runtime-worker-thread`

```ts config-catalog
/** Plugin config: every execution cap, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /**
   * Busy-time budget in milliseconds: the run fails with kind `'timeout'`
   * once the worker's MEASURED event-loop active time
   * (`worker.performance.eventLoopUtilization()`) exceeds this. Metering
   * measured busy time — not wall time, not host-side pending-call
   * bookkeeping — is what makes the budget both fair (a program awaiting a
   * slow tool accrues nothing) and ungameable (a hot loop accrues whether
   * or not a decoy dispatch is in flight).
   */
  computeMs?: number
  /**
   * Wall-clock ceiling in milliseconds; never pauses for anything. The
   * backstop for what busy-time cannot see (a program awaiting a promise
   * nobody will resolve). At most `2_147_483_647` (Node's maximum
   * `setTimeout` delay, about 24.9 days): a longer value is rejected at load
   * because `setTimeout` would clamp it to 1 ms.
   */
  maxWallMs?: number
  /**
   * Hard cap for serialized log-array, completion-value, and failure-message payloads;
   * fixed result-envelope syntax is excluded.
   */
  maxOutputBytes?: number
  /** The worker's max old-generation heap in MiB (`resourceLimits`); overflow kills the worker, surfacing as kind `'worker-exit'`. */
  maxOldGenerationSizeMb?: number
}
```

来源：[`packages/code-runtime/code-runtime-worker-thread/src/index.ts:25`](../packages/code-runtime/code-runtime-worker-thread/src/index.ts)

<a id="deepseek-aidsh-compaction-basic"></a>

## `@deepseek-ai/dsh-compaction-basic`

需要：`llm` · `tokenMeter` · `sessions`

```ts config-catalog
/** Basic compaction configuration with an optional exact-target policy table. */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** Enable automatic exact-request pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
}

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Compact at this fraction of the model's context window. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Recent context retained as a fraction of the model's window. Defaults to `0.16`. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum replacement retries per preflight or provider-overflow sequence; `0` disables both. Defaults to `1`. */
  maxOverflowRetries?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}
```

来源：[`packages/compaction/compaction-basic/src/types.ts:38`](../packages/compaction/compaction-basic/src/types.ts)

<a id="deepseek-aidsh-compaction-tool-result-pruner"></a>

## `@deepseek-ai/dsh-compaction-tool-result-pruner`

需要：`tokenMeter`

```ts config-catalog
/** Character-budget policy for deterministic tool-result pruning. */
export interface ToolResultPruneConfig {
  /** Prune when total text exceeds this many Unicode code points. Defaults to `8192`. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained. Defaults to `4096`. */
  headChars?: number
  /** Maximum trailing Unicode code points retained. Defaults to `1024`. */
  tailChars?: number
}
```

来源：[`packages/compaction/compaction-tool-result-pruner/src/types.ts:5`](../packages/compaction/compaction-tool-result-pruner/src/types.ts)

<a id="deepseek-aidsh-cordis-host-runner"></a>

## `@deepseek-ai/dsh-cordis-host-runner`

需要：`tools`

```ts config-catalog
/** Runner configuration. */
export interface Config {
  /** Maximum synchronous VM evaluation time in milliseconds. */
  vmTimeoutMs?: number
}
```

来源：[`packages/extensions/cordis-host-runner/src/index.ts:88`](../packages/extensions/cordis-host-runner/src/index.ts)

<a id="deepseek-aidsh-credentials-local"></a>

## `@deepseek-ai/dsh-credentials-local`

```ts config-catalog
/** Plugin config: file location and hot-reload behavior. */
export interface Config {
  /** Credentials document path; defaults to `.credentials.yaml` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Watch the document and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}
```

来源：[`packages/credentials/credentials-local/src/index.ts:64`](../packages/credentials/credentials-local/src/index.ts)

<a id="deepseek-aidsh-e2b"></a>

## `@deepseek-ai/dsh-e2b`

```ts config-catalog
/** Configuration for the shared E2B sandbox owner. */
export interface Config {
  /** API key; omission reads `E2B_API_KEY`. It is never forwarded into the sandbox. */
  apiKey?: string
  /** Shared remote working directory, created before adapters receive the sandbox. */
  cwd?: string
  /** E2B sandbox lifetime in milliseconds; expiry always deletes the sandbox. */
  timeoutMs?: number
}
```

来源：[`packages/e2b/e2b/src/index.ts:43`](../packages/e2b/e2b/src/index.ts)

<a id="deepseek-aidsh-experimental-agent-team"></a>

## `@deepseek-ai/dsh-experimental-agent-team`

需要：`agents` · `sessions` · `sessionPersistence` · `sessionProjections` · `subagents`

```ts config-catalog
/** Team-service deployment limits. */
export interface Config {
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum queued-minus-delivered messages for one target member. */
  readonly maxPendingMessagesPerMember?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds allowed for Team-owned runtime disposal. */
  readonly disposalTimeoutMs?: number
}
```

来源：[`packages/experimental/agent-team/src/types.ts:125`](../packages/experimental/agent-team/src/types.ts)

<a id="deepseek-aidsh-experimental-code-runtime-python"></a>

## `@deepseek-ai/dsh-experimental-code-runtime-python`

```ts config-catalog
/** Plugin config: every cap, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /**
   * RLIMIT_CPU in whole seconds (a positive integer — `setrlimit` in the child
   * rejects a float). The child sets the soft limit to `cpuSeconds` and the
   * hard limit to `cpuSeconds + 1`: the kernel delivers SIGXCPU at the soft
   * limit, which the host classifies as a `timeout`; the +1s hard limit is a
   * SIGKILL backstop for a program that traps SIGXCPU. Granularity is seconds —
   * a coarser counterpart to the worker backend's millisecond `computeMs`.
   */
  cpuSeconds?: number
  /** Wall-clock ceiling in milliseconds; backstops CPU time for programs awaiting a promise nobody resolves. */
  maxWallMs?: number
  /**
   * RLIMIT_AS in mebibytes; caps address space so a runaway allocation fails
   * cleanly. Not applied on Darwin, where the dyld shared cache mapped into
   * every process at exec exceeds any practical cap and the kernel rejects
   * the call; `cpuSeconds` and `maxWallMs` still bound the run there. Bounds
   * `maxLogBytes`/`maxValueBytes` at load on EVERY platform (this static check
   * runs on Darwin too, where only the runtime `setrlimit` is skipped): each
   * budget times a worst-case Unicode expansion must fit this byte count minus a
   * fixed interpreter baseline, so a near-budget output cannot breach the address
   * space during the child's build-and-encode.
   */
  addressSpaceMb?: number
  /**
   * Shared byte budget for captured log text (host-side ledger). Bounded at load
   * against `addressSpaceMb`: the child builds and encodes a near-budget entry
   * under RLIMIT_AS with several copies live at once, so this cap times the
   * worst-case Unicode expansion must fit the address space left after the
   * interpreter baseline (see `addressSpaceMb`) — a load-time rejection, not a
   * runtime clamp. Also bounded at load by the host's configured heap like
   * `maxValueBytes` (see its JSDoc): the effective frame cap minus the frame
   * envelope.
   */
  maxLogBytes?: number
  /**
   * Byte cap for the completion value. Bounded at load against `addressSpaceMb`
   * the same way `maxLogBytes` is: the child builds and encodes a near-budget
   * value under RLIMIT_AS with several copies live at once, so this cap times the
   * worst-case Unicode expansion must fit the address space left after the
   * interpreter baseline. Both budgets are ALSO bounded at load by the host's
   * configured heap: the effective frame cap (the protocol cap, or a lower
   * heap-derived ceiling when the host heap cannot safely parse a near-cap
   * frame — see `hostFrameParseCeiling`) minus the frame envelope, so a budget
   * whose honest frame could OOM the host's own JSON.parse is rejected up
   * front.
   */
  maxValueBytes?: number
  /** SIGTERM→SIGKILL grace period on kill, matching bash-local's default. */
  graceMs?: number
  /**
   * Absolute path, relative path, or basename of a CPython 3.10+ interpreter.
   * Resolved and validated once at plugin load under a five-second force-kill
   * deadline; a basename searches `PATH`.
   */
  pythonBin?: string
}
```

来源：[`packages/experimental/code-runtime-python/src/index.ts:42`](../packages/experimental/code-runtime-python/src/index.ts)

<a id="deepseek-aidsh-experimental-inspector"></a>

## `@deepseek-ai/dsh-experimental-inspector`

需要：`webServer`

```ts config-catalog
/** Host plugin configuration. Fetch capture is enabled by default. */
export interface Config extends Omit<InspectorOptions, 'clientOrigins'> {
  /** Browser origins allowed to open the Client ingest WebSocket. */
  clientOrigins?: string[]
}

/** User-facing Host options; every memory and lifecycle bound is configurable. */
export interface InspectorOptions {
  /** Loopback address used by the Worker HTTP and WebSocket endpoint. */
  readonly host?: '127.0.0.1'
  /** First port to bind; occupied ports advance until one is available. */
  readonly port?: number
  /** Additional exact browser origins admitted to the Client ingest socket. */
  readonly clientOrigins?: readonly string[]
  /** Whether to observe calls made through the current global fetch function. */
  readonly captureFetch?: boolean
  /** Maximum request-body prefix retained for one fetch. */
  readonly maxRequestBodyBytes?: number
  /** Maximum response-body prefix retained for one fetch. */
  readonly maxResponseBodyBytes?: number
  /** Maximum raw bytes encoded into one body observation. */
  readonly maxBodyChunkBytes?: number
  /** Maximum total request and response body bytes retained by the Worker. */
  readonly maxJournalBytes?: number
  /** Maximum active and completed fetch requests retained by the Worker. */
  readonly maxRetainedRequests?: number
  /** Maximum encoded bytes accepted in one source transport frame. */
  readonly maxSourceFrameBytes?: number
  /** Maximum observation records accepted in one source batch. */
  readonly maxSourceRecordsPerFrame?: number
  /** Maximum records waiting in one producer queue. */
  readonly maxQueuedRecords?: number
  /** Maximum encoded bytes waiting in one producer queue. */
  readonly maxQueuedBytes?: number
  /** Maximum time allowed for the Worker to become ready. */
  readonly startupTimeoutMs?: number
  /** Grace period before a stopping Worker is terminated. */
  readonly stopTimeoutMs?: number
  /** Initial upper bound for randomized Client reconnect delay. */
  readonly clientReconnectBaseMs?: number
  /** Maximum upper bound for randomized Client reconnect delay. */
  readonly clientReconnectMaxMs?: number
  /** Deadline for one Worker-to-Client Runtime or Sources request. */
  readonly clientRuntimeTimeoutMs?: number
  /** Deadline for one non-CDP semantic query. */
  readonly queryTimeoutMs?: number
  /** Maximum live object handles retained per Client Runtime session. */
  readonly maxClientRuntimeObjects?: number
  /** Maximum descriptors returned by one Client property request. */
  readonly maxClientRuntimeProperties?: number
  /** Maximum encoded bytes read for one Client script or source map. */
  readonly maxClientSourceBytes?: number
  /** Maximum Context and Fiber nodes retained in one realm snapshot. */
  readonly maxCordisNodes?: number
  /** Disconnected Cordis snapshots retained after their live realm closes. */
  readonly maxDisconnectedCordisTrees?: number
}
```

来源：[`packages/experimental/inspector/src/index.ts:66`](../packages/experimental/inspector/src/index.ts)

<a id="deepseek-aidsh-experimental-tool-agent-team"></a>

## `@deepseek-ai/dsh-experimental-tool-agent-team`

需要：`agents` · `agentTeams` · `tools` · `systemPrompt`

```ts config-catalog
/** Tool routing configuration. */
export interface Config {
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts:17`](../packages/experimental/tool-agent-team/src/index.ts)

<a id="deepseek-aidsh-file-reference-local"></a>

## `@deepseek-ai/dsh-file-reference-local`

需要：`agents` · `sessionProjections`

```ts config-catalog
/** Local file-reference discovery configuration. */
export interface Config {
  /** Maximum ranked candidates returned for one query. */
  maxResults?: number
  /** Maximum indexed files and directories per agent workspace. */
  maxEntries?: number
  /** Directory basenames never traversed or offered. */
  excludedDirectories?: string[]
}
```

来源：[`packages/context/file-reference-local/src/index.ts:34`](../packages/context/file-reference-local/src/index.ts)

<a id="deepseek-aidsh-fs-local"></a>

## `@deepseek-ai/dsh-fs-local`

```ts config-catalog
/** Configuration for the local filesystem backend. */
export interface Config {
  /** Base directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Exclusive UTF-8 byte limit on each overwrite-diff side, capped by the
   * runtime's safe allocation/decode maximum. Defaults to 10 MiB.
   */
  diffBasisMaxBytes?: number
}
```

来源：[`packages/fs/fs-local/src/index.ts:41`](../packages/fs/fs-local/src/index.ts)

<a id="deepseek-aidsh-fs-sandbox"></a>

## `@deepseek-ai/dsh-fs-sandbox`

需要：`sandboxPolicy`

```ts config-catalog
/**
 * Plugin config: the local backend's knobs verbatim (`cwd` resolution default
 * and `diffBasisMaxBytes` overwrite-presentation bound). The sandbox default
 * (mode + `workspace-write` fallback root) is NOT here — `ctx.sandboxPolicy`
 * resolves each calling session for every enforcing capability.
 */
export type Config = LocalConfig
```

依赖：[`LocalConfig`](#deepseek-aidsh-fs-local)

来源：[`packages/fs/fs-sandbox/src/index.ts:45`](../packages/fs/fs-sandbox/src/index.ts)

<a id="deepseek-aidsh-goal"></a>

## `@deepseek-ai/dsh-goal`

需要：`agents` · `sessionProjections`

```ts config-catalog
/** Deployment defaults for goal creation. */
export interface Config {
  /** Total rounds used when a create request omits its own cap. */
  defaultMaxGoalRounds?: number
}
```

来源：[`packages/goal/goal/src/index.ts:172`](../packages/goal/goal/src/index.ts)

<a id="deepseek-aidsh-goal-round-driver"></a>

## `@deepseek-ai/dsh-goal-round-driver`

需要：`agents` · `goals` · `sessions`

```ts config-catalog
/** Deployment-level policy for automatic goal continuation. */
export interface Config {
  /** Conditions that may reserve the next goal round. */
  wake: {
    /** `always` preserves immediate continuation; `event-driven` waits while owned work remains live. */
    mode: 'always' | 'event-driven'
    /** Maximum quiet wait before a safety-net continuation. */
    timeoutMs: number
  }
}
```

来源：[`packages/goal/goal-round-driver/src/index.ts:26`](../packages/goal/goal-round-driver/src/index.ts)

<a id="deepseek-aidsh-headless"></a>

## `@deepseek-ai/dsh-headless`

需要：`agentDefaultModel` · `agents` · `sessions`

```ts config-catalog
/** Plugin config: the task resolved from this app's injected provider service. */
export interface Config {
  /** The prompt text for the single run. */
  task: string
}
```

来源：[`packages/bundle/headless/src/index.ts:33`](../packages/bundle/headless/src/index.ts)

<a id="deepseek-aidsh-hooks-claude-code"></a>

## `@deepseek-ai/dsh-hooks-claude-code`

需要：`shell` · `sessionProjections`

```ts config-catalog
/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * Process-level: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process.
   * TODO(per-session-hook-config): per-session discovery of a project-local
   * `hooks.json` from each `session/new.cwd`.
   */
  configPath: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's session workspace (`session.header.cwd`, the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}
```

来源：[`packages/hooks/hooks-claude-code/src/index.ts:46`](../packages/hooks/hooks-claude-code/src/index.ts)

<a id="deepseek-aidsh-hooks-codex"></a>

## `@deepseek-ai/dsh-hooks-codex`

需要：`shell` · `sessionProjections`

```ts config-catalog
/** Plugin config: where the Codex hooks.json lives + the model name for payloads. */
export interface Config {
  /**
   * Path to a Codex `hooks.json`. Process-level: read once at load, a relative
   * path resolves against the process launch cwd.
   * TODO(per-session-hook-config): per-session project-local discovery from each
   * `session/new.cwd`.
   */
  configPath: string
  /** The model name stamped on every payload (Codex includes `model` on each event). */
  model?: string
  /** Default per-hook timeout in ms when a hook sets none (Codex default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}
```

来源：[`packages/hooks/hooks-codex/src/index.ts:45`](../packages/hooks/hooks-codex/src/index.ts)

<a id="deepseek-aidsh-host-directory-picker-browse"></a>

## `@deepseek-ai/dsh-host-directory-picker-browse`

```ts config-catalog
/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link BrowseDirectoryPicker.Config}. */
  maxEntries: number
}
```

来源：[`packages/host/directory-picker-browse/src/index.ts:181`](../packages/host/directory-picker-browse/src/index.ts)

<a id="deepseek-aidsh-host-frontend-static"></a>

## `@deepseek-ai/dsh-host-frontend-static`

需要：`webServer` · `connection`

```ts config-catalog
/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}
```

来源：[`packages/host/frontend-static/src/index.ts:30`](../packages/host/frontend-static/src/index.ts)

<a id="deepseek-aidsh-host-webserver"></a>

## `@deepseek-ai/dsh-host-webserver`

```ts config-catalog
/** Gateway config: the listen address plus the response-policy knobs. */
export interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** Whether responses are compressed at all. */
  compress?: boolean
  /** Smallest body the carrier encodes. */
  compressMinBytes?: number
  /** Brotli quality, 0-11. */
  brotliQuality?: number
  /** Deflate level for gzip, 0-9. */
  gzipLevel?: number
  /** Content-hashed asset pathname prefixes. */
  immutablePathPrefixes?: string[]
  /** Lifetime for immutable responses, in seconds. */
  immutableMaxAgeSeconds?: number
}
```

来源：[`packages/host/webserver/src/index.ts:59`](../packages/host/webserver/src/index.ts)

<a id="deepseek-aidsh-invariants"></a>

## `@deepseek-ai/dsh-invariants`

```ts config-catalog
/** Runtime invariant selection configured on the service plugin. */
export interface Config {
  /** Global switch; defaults to `true`. */
  readonly enabled?: boolean
  /** Case-sensitive JavaScript regex sources that admit package names; empty admits all. */
  readonly package_allowlist?: string[]
  /** Case-sensitive JavaScript regex sources that exclude package names after allowlist matching. */
  readonly package_blocklist?: string[]
}
```

来源：[`packages/runtime-diagnostics/invariants/src/index.ts:15`](../packages/runtime-diagnostics/invariants/src/index.ts)

<a id="deepseek-aidsh-jobs-local"></a>

## `@deepseek-ai/dsh-jobs-local`

```ts config-catalog
/** Configuration for the process-local job registry. */
export interface Config {
  /**
   * Maximum `running` plus `stopping` jobs per exact owner or in the shared unowned bucket;
   * omission defaults to 10.
   */
  maxConcurrentJobsPerOwner?: number
}
```

来源：[`packages/jobs/jobs-local/src/index.ts:31`](../packages/jobs/jobs-local/src/index.ts)

<a id="deepseek-aidsh-llm-deepseek"></a>

## `@deepseek-ai/dsh-llm-deepseek`

需要：`llm`

```ts config-catalog
/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-deepseek` settings-section shape. Every field is optional in
 * yml: a missing API key resolves through {@link Config.apiKeyEnv} at each
 * request (a request without any key fails with `MISSING_CREDENTIAL`, not at
 * plugin load), omitted thinking mode uses the provider default, and omitted
 * reasoning effort resolves to `high`.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; falls back to $DEEPSEEK_BASE_URL from a trusted environment layer, then the public API. */
  baseURL?: string
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort (default `high`); `off` disables thinking per request. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Default per-request output cap (default 256,000); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to V4 Flash, V4 Pro, and V4 Flash Vision Exp. */
  models?: DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Maximum accumulated file-referenced image bytes per chat request (default 128 MiB). */
  maxRequestFilesBytes?: number
  /** Maximum accumulated base64 image payload after Files API fallback (default 20 MiB). */
  maxInlineRequestImageBytes?: number
  /** Maximum number of represented images per chat request (default 600). */
  maxImagesPerRequest?: number
  /** Raw-byte removal step after the request exceeds its file bound (default 64 MiB). */
  imageOffloadByteQuantum?: number
  /** Base64-byte removal step after inline fallback exceeds its bound (default 10 MiB). */
  inlineImageOffloadByteQuantum?: number
  /** Image-count removal step after the request exceeds its count bound (default 20). */
  imageOffloadCountQuantum?: number
  /** Maximum duration of one request-image Files API resolution (default one minute). */
  filesApiTimeoutMs?: number
  /** Explicit lifetime assigned to each uploaded image (default seven days). */
  fileExpiresAfterSeconds?: number
  /** Remaining lifetime below which an indexed file is replaced (default one hour). */
  fileRefreshMarginSeconds?: number
  /** Oldest harness-owned files deleted before one quota-recovery upload retry (default 100). */
  fileQuotaCleanupBatch?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

/** One optional model entry advertised by the direct-fetch adapter. */
export interface DeepSeekCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link DeepSeekConnectionOptions.maxTokens}. */
  maxTokens?: number
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[]
  /** Total-pixel budget for one deterministic request preview, or the 512-by-512 `low` preset. */
  imagePixelBudget?: number | 'low'
  /** Encoded-byte target for one deterministic request preview; the smallest quality-ladder output is used when no quality fits. */
  imageMaxBytes?: number
}
```

依赖：[`ModelModality`](../packages/llm/llm/src/index.ts) · [`RetryPolicyConfig`](../packages/llm/llm/src/index.ts)

来源：[`packages/llm/llm-deepseek/src/index.ts:125`](../packages/llm/llm-deepseek/src/index.ts)

<a id="deepseek-aidsh-llm-pi-ai"></a>

## `@deepseek-ai/dsh-llm-pi-ai`

需要：`llm`

```ts config-catalog
/** Plugin configuration: the provider routes this instance owns. */
export interface Config {
  /**
   * pi-ai provider routes, keyed by provider. An empty (or omitted) dict is
   * the dormant settings-driven posture: the adapter mounts with no routes
   * and registers them the moment a settings section supplies profiles.
   */
  providers?: Record<string, PiAiProviderProfile>
}

/** Configuration for one pi-ai provider route; the `providers` dict key IS the route. */
export interface PiAiProviderProfile {
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
  /** Name shown by configuration surfaces; defaults to the route key. */
  displayName?: string
  /**
   * Wire protocol every model on this route speaks. Omission keeps each
   * installed catalog model's own protocol, which is why a catalog route needs
   * no protocol at all; a route the catalog does not ship must name one.
   */
  api?: string
  /** Endpoint for this route's models; defaults to the installed catalog's endpoint. */
  baseURL?: string
  /**
   * This route's model catalog. Omission serves the installed catalog for the
   * route unchanged; an explicit list replaces it, each entry defaulting its
   * unset fields from the installed model of the same id.
   */
  models?: PiAiModelProfile[]
  /**
   * Installed-catalog customizations by model id: each entry reshapes that
   * one model with the same fields a {@link models} entry takes, while the
   * rest of the catalog keeps serving untouched. Only meaningful on a catalog
   * route with no `models` list — `models` already replaces the catalog, so
   * an override beside it, on a route the catalog does not ship, or naming a
   * model the catalog does not describe is refused rather than skipped.
   */
  modelOverrides?: Record<string, PiAiModelOverride>
  /**
   * pi-ai wire-compatibility switches defaulting every model on this route
   * whose protocol declares them; each model's own `compat` overrides per
   * field. What neither sets keeps the installed catalog entry's value, then
   * pi-ai's own detection. A switch no model on the route could read is
   * refused rather than left looking applied.
   */
  compat?: PiAiCompatProfile
  /**
   * Context capacity for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 262,144). A guess by construction, so
   * a deployment whose gateway serves smaller models corrects it here.
   */
  defaultContextWindow?: number
  /**
   * Output capability for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 32,768). This sizes the model; it
   * never becomes a per-request cap on its own.
   */
  defaultMaxTokens?: number
  /**
   * Request modalities for a model this route lists that neither its entry's
   * {@link PiAiModelProfile.input} nor the installed catalog declares (default
   * `[text]`). A fallback like the capacities above, not an override: a
   * catalog model keeps the modalities the catalog records for it, and this
   * value never narrows one. A gateway serving vision models the catalog does
   * not describe declares `[text, image]` once here instead of on every entry.
   * Unlike an entry's list, this one may not be empty — nothing sits below it
   * to answer instead.
   */
  defaultInput?: PiAiModality[]
  /** Provider request headers, validated against Fetch when the profile resolves; Harness attribution wins reserved names. */
  headers?: Record<string, string>
  /** Provider-neutral pi-ai reasoning level. */
  reasoning?: ModelThinkingLevel
  /** Token budgets used by reasoning providers that support them. */
  thinkingBudgets?: ThinkingBudgets
  /** Prompt-cache retention preference. */
  cacheRetention?: CacheRetention
  /** Streaming transport preference. */
  transport?: Transport
  /** HTTP/provider SDK timeout in milliseconds. */
  timeoutMs?: number
  /** WebSocket connection timeout in milliseconds. */
  websocketConnectTimeoutMs?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /**
   * Maximum base64-encoded image payload per request. When a request's
   * accumulated images exceed it, the oldest images are replaced by text
   * placeholders until the request fits, so a long session keeps completing
   * requests instead of being rejected by a request-size cap.
   */
  maxRequestImageBytes?: number
  /** Total-pixel budget for each deterministic inline request version. */
  requestImagePixelBudget?: number
  /**
   * Raw encoded-byte target for each deterministic inline request version;
   * the smallest quality-ladder output is used when no quality fits.
   */
  requestImageMaxBytes?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
  /**
   * Recovery from a provider auth rejection (HTTP 401/403) that arrives before
   * any content: the adapter refreshes the route's stored OAuth credential
   * once, then retries after {@link PiAiAuthRecovery.delayMs}. Only a failure
   * with nothing emitted is eligible — once content has streamed, the turn
   * owns recovery. Omission enables one recovery attempt; `retries: 0`
   * disables it.
   */
  authRecovery?: PiAiAuthRecovery
}

/** One configured model entry: an id plus the catalog fields it overrides. */
export interface PiAiModelProfile {
  /** Model id sent to the provider and accepted by {@link GenerateOptions.model}. */
  id: string
  /** Display name for selectors; defaults to the catalog name, then the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /**
   * Maximum output tokens. Configuring one also makes it this model's
   * per-request default; a value inherited from the installed catalog, or the
   * route's fallback, is the model's capability and never becomes a request
   * default on its own.
   */
  maxTokens?: number
  /**
   * Request modalities this model accepts. Absent — or empty, which describes
   * a model that accepts nothing and so states no answer either — keeps the
   * installed catalog entry's modalities, then the route's `defaultInput`.
   * Declaring images is what makes a hand-declared vision model usable, and
   * declaring text alone corrects a catalog model whose gateway does not serve
   * what the catalog records. This is a claim about the endpoint, not a check
   * of it: nothing interrogates a gateway for what it accepts, so a model
   * claiming images its endpoint refuses is refused by the provider instead,
   * mid-turn.
   */
  input?: PiAiModality[]
  /**
   * Selectable reasoning efforts. Absent inherits the installed catalog
   * entry's capability (a hand-declared model has none and does not reason);
   * `false` declares a non-reasoning model, which is how a profile strips
   * reasoning from a catalog model its gateway cannot serve; a non-empty dict
   * declares the offered levels and their wire spellings.
   */
  reasoningEfforts?: false | PiAiReasoningEfforts
  /** pi-ai wire-compatibility switches for this model, winning over the route's per field; one its protocol does not declare is refused. */
  compat?: PiAiCompatProfile
}

/**
 * Customization of one installed catalog model, keyed by its id in the
 * route's `modelOverrides` dict — the same fields a `models` entry may set,
 * with the id living in the key. Unlike a `models` list, overrides leave the
 * rest of the catalog serving untouched, which is what makes "correct one
 * model, keep the other thirty-seven" a three-line edit.
 */
export type PiAiModelOverride = Omit<PiAiModelProfile, 'id'>

/**
 * pi-ai wire-compatibility switches, set on the route (its models' default) or
 * per model (winning over the route, field by field).
 *
 * pi-ai decides each of these from the provider id and baseURL when no layer
 * sets it, and a private gateway's URL says nothing: for an endpoint it does
 * not recognize the detection answers as though it were OpenAI itself, which
 * is wrong for most OpenAI-compatible gateways. So every field here is one a
 * deployment must be able to state because nothing can infer it, while the
 * fields pi-ai's catalog sets for a named vendor stay withheld.
 *
 * A field belongs to the protocols whose upstream compat type declares it: a
 * model-level switch its protocol does not take fails resolution, and a
 * route-level one skips past models it cannot fit. "The three Responses
 * protocols" below means `openai-responses`, `azure-openai-responses`, and
 * `openai-codex-responses`, which pi-ai gives one shared compat type, so a
 * switch settable on one is settable on all three.
 */
export interface PiAiCompatProfile {
  /** Whether the endpoint accepts `store`; `openai-completions`. */
  supportsStore?: boolean
  /**
   * Whether the endpoint accepts the `developer` role for the system prompt,
   * which pi-ai sends only to a reasoning model; `false` keeps `system`.
   * `openai-completions` and the three Responses protocols.
   */
  supportsDeveloperRole?: boolean
  /** Whether the endpoint accepts `reasoning_effort`; `openai-completions`. */
  supportsReasoningEffort?: boolean
