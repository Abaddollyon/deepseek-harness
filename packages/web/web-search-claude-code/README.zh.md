# @deepseek-ai/dsh-web-search-claude-code

[English](README.md) | 中文

面向 [`ctx.web`](../web/README.zh.md) 的官方订阅原生 Claude Code web 搜索提供方。它使用 `@anthropic-ai/claude-agent-sdk`，只启用 Claude Code 的 `WebSearch` 工具，并以 `permissionMode: 'dontAsk'` 与 `persistSession: false` 在一次临时 SDK query 中运行整个有序查询批次。认证由 SDK 及其 Claude Code 进程拥有；本包绝不读取、复制、记录、导出或转发 OAuth token，也绝不回退到 API key 提供方。

提供方只从结构化 `WebSearch` 工具结果映射引用。最终 SDK 结构化输出可以补充有依据的答案，但不能创造来源 URL。缺失、重复、乱序或畸形查询数据会成为安全的 `WEB_PROVIDER_PROTOCOL` 结果。web seam 负责最终 HTTP(S) 过滤、规范化、去重、缓存、singleflight 与来源上限。一次提供方失败不会触发隐藏重试。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---:|---|
| `cwd` | Host 进程 cwd | 传给官方 SDK 的工作目录。 |
| `graceMs` | `3000` | 受管进程树终止宽限时间。 |
| `maxTurns` | `4` | 一个原生批次的最大 SDK 对话轮数。 |

插件注入 `web` 与 `subprocess`。自定义 SDK spawn 被投影到共享 subprocess 所有者，因此取消会关闭 SDK query、终止完整进程树，并在返回前等待进程收敛。`available()` 是不消耗搜索的包就绪检查；授权错误留在官方运行时内部，并以安全提供方失败浮出。

## 模型体验

### 原生 Claude 搜索 query

#### 模型可见内容

一个 Agent SDK query 接收生成的指令，其中包含有序的缓存 miss 查询、受支持的域名控制和结构化输出 schema。它不会收到 DSH 会话历史、提供方凭据、OAuth token 或恢复的 SDK 会话，并且只能调用 `WebSearch`。

#### Token 影响

每个协调后的 miss 批次使用一个订阅原生 Claude query，`maxTurns` 限制其 turn 数。官方 SDK 拥有用量计量；不存在 API-key 搜索请求或重试。

#### KV 缓存影响

query 不持久化或恢复会话，因此原生搜索批次不共享保留的会话前缀，也不影响 DSH 会话模型的缓存。

### 会话工具结果（间接）

#### 模型可见内容

通过 `@deepseek-ai/dsh-tool-web` 间接生效：成功答案、规范化引用与安全部分失败保留在已记录的工具结果中。提供方和进程细节不会进入面向模型的 schema 或提示词。

#### Token 影响

使用前不增加提示词 token。每次调用会把消费方渲染的成功答案、受限引用和安全的逐查询失败加入已记录的工具结果。

#### KV 缓存影响

以追加方式位于可复用会话前缀之后；保留的搜索结果遵循工具消费方的压缩行为。

## 已知限制与暂缓事项

- Claude Agent SDK 的 `WebSearch` 暴露允许／阻止域名，但没有原生新鲜度、位置或结果数量参数。域名控制和位置会进入精确批次指令；提供方还会独立按允许／阻止 hostname 后过滤每条引用，因此即使模型遗漏工具参数，不允许的来源也无法到达调用方。上游搜索仍可能查看不允许的结果，并且无法独立强制地理相关性。web seam 强制执行结果上限；新鲜度仍不受支持。
- 如果不越过官方认证边界，availability 无法检查 OAuth 状态，因此只在 SDK 运行时验证认证。
